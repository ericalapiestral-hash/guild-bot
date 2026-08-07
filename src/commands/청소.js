const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  InteractionContextType,
} = require('discord.js');
const { sendLog, makeEmbed, clamp, userLine, markCommandBulk } = require('../logger');

/** 디스코드는 14일이 지난 메시지를 일괄 삭제하지 못한다 (API 제약, 우회 불가) */
const BULK_LIMIT_MS = 14 * 24 * 60 * 60 * 1000 - 60_000;

/** 한 번에 지울 수 있는 최대치. 100개씩 나눠서 여러 번 돈다. */
const MAX_DELETE = 1000;

/** 디스코드가 한 번에 돌려주는 메시지 수 */
const PAGE = 100;

/** 멤버로 거를 때 훑을 최대 메시지 수 — 끝없이 거슬러 올라가지 않게 */
const MAX_SCAN = 5000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('청소')
    .setDescription('이 채널의 최근 메시지를 지웁니다 (최대 1000개).')
    .addIntegerOption((option) =>
      option
        .setName('개수')
        .setDescription(`지울 메시지 수 (1~${MAX_DELETE})`)
        .setMinValue(1)
        .setMaxValue(MAX_DELETE)
        .setRequired(true),
    )
    .addUserOption((option) =>
      option.setName('멤버').setDescription('이 멤버의 메시지만 지우기 (선택)'),
    )
    .addStringOption((option) =>
      option.setName('사유').setDescription('로그에 남길 사유 (선택)').setMaxLength(200),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const amount = interaction.options.getInteger('개수');
    const target = interaction.options.getUser('멤버');
    const reason = interaction.options.getString('사유');
    const channel = interaction.channel;

    const me = interaction.guild.members.me;
    if (!channel || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.editReply('이 채널에서 봇에게 **메시지 관리** 권한이 없어요.');
      return;
    }

    const cutoff = Date.now() - BULK_LIMIT_MS;
    let deleted = 0;
    let scanned = 0;
    let tooOld = 0;
    let hitAgeWall = false;
    let lastProgressAt = 0;
    let before;

    try {
      while (deleted < amount && scanned < MAX_SCAN) {
        const batch = await channel.messages.fetch({ limit: PAGE, before });
        if (batch.size === 0) break;

        scanned += batch.size;
        before = batch.last().id; // 다음 장은 이 메시지보다 더 이전 것

        const usable = [...batch.values()].filter((m) => {
          if (m.pinned) return false; // 고정 메시지는 건드리지 않는다
          if (m.createdTimestamp <= cutoff) {
            hitAgeWall = true;
            tooOld += 1;
            return false;
          }
          return !target || m.author.id === target.id;
        });

        // 이 장이 통째로 14일보다 오래됐으면 더 거슬러 올라가도 지울 게 없다
        const allOld = batch.every((m) => m.createdTimestamp <= cutoff);

        const chunk = usable.slice(0, amount - deleted);
        if (chunk.length > 0) {
          markCommandBulk(channel.id); // 일괄삭제 로그가 여러 번 뜨는 것 방지
          try {
            if (chunk.length === 1) {
              // 디스코드 일괄삭제는 2개 이상이어야 한다
              await chunk[0].delete();
              deleted += 1;
            } else {
              deleted += (await channel.bulkDelete(chunk, true)).size;
            }
          } catch (e) {
            // 그새 누가 지웠거나 순간적으로 막힌 경우 — 다음 장으로 넘어간다
            console.warn(`[청소] 일부 삭제 실패: ${e.message}`);
          }
        }

        if (allOld) break;

        // 오래 걸리는 작업이라 진행 상황을 알려준다
        if (deleted > 0 && Date.now() - lastProgressAt > 4000 && deleted < amount) {
          lastProgressAt = Date.now();
          await interaction
            .editReply(`🧹 지우는 중… ${deleted}개 완료 (목표 ${amount}개)`)
            .catch(() => {});
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await interaction.editReply({
        content: `⚠️ 지우다가 멈췄어요 (${deleted}개까지 지움): ${msg}`.slice(0, 1900),
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (deleted === 0) {
      await interaction.editReply({
        content: target
          ? `${target}님의 지울 수 있는 메시지를 찾지 못했어요.${hitAgeWall ? ' (14일이 지난 메시지는 지울 수 없어요)' : ''}`
          : `지울 수 있는 메시지가 없어요.${hitAgeWall ? ' (14일이 지난 메시지는 지울 수 없어요)' : ''}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const lines = [`✅ 메시지 **${deleted}개**를 지웠어요.`];
    if (target) lines.push(`대상: ${target}`);
    if (deleted < amount) {
      if (hitAgeWall) {
        lines.push(`14일이 지난 메시지 ${tooOld}개는 디스코드 제약상 지울 수 없어 멈췄어요.`);
      } else if (scanned >= MAX_SCAN) {
        lines.push(`최근 ${MAX_SCAN}개까지 훑어봤어요. 더 필요하면 한 번 더 실행해주세요.`);
      } else {
        lines.push('채널에 더 지울 메시지가 없어요.');
      }
    }

    await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });

    const embed = makeEmbed('청소', '🧽 /청소 실행됨')
      .addFields({ name: '실행자', value: clamp(userLine(interaction.user), 1000) })
      .addFields({ name: '채널', value: `<#${channel.id}>` })
      .addFields({ name: '지운 개수', value: `${deleted}개`, inline: true });
    if (target) {
      embed.addFields({ name: '대상 멤버', value: clamp(userLine(target), 1000), inline: true });
    }
    if (reason) embed.addFields({ name: '사유', value: clamp(reason, 1000) });
    if (hitAgeWall && deleted < amount) {
      embed.addFields({ name: '참고', value: '14일이 지난 메시지가 있어 중간에 멈췄어요' });
    }
    await sendLog(interaction.guild, embed);
  },
};
