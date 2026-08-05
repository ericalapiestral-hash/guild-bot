// 노션 도감이 실제로 어떤 구조인지 눈으로 확인하는 점검용 스크립트.
//   npm run notion:dump
// data/notion-dump.md 에 읽어온 마크다운 전체를 저장하고, 인식된 빌드 목록을 출력한다.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { fetchDocument } = require('./notion');
const { buildsFromMarkdown } = require('./builds');

(async () => {
  try {
    const pageId = process.env.NOTION_PAGE_ID;
    if (!pageId) throw new Error('NOTION_PAGE_ID가 없어요. .env를 확인해주세요.');

    console.log('노션에서 도감을 읽는 중...');
    const doc = await fetchDocument(pageId);

    const outDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'notion-dump.md');
    fs.writeFileSync(outPath, doc.markdown, 'utf8');

    const found = buildsFromMarkdown(doc.markdown, { pageUrl: doc.pageUrl });
    console.log(`\n제목: ${doc.title}`);
    console.log(`페이지 ${doc.pageCount}개 · 마크다운 ${doc.markdown.length.toLocaleString('ko-KR')}자`);
    console.log(`저장: ${outPath}`);
    console.log(`\n인식된 빌드 ${found.length}개`);

    for (const category of ['공성전', '파괴신']) {
      const list = found.filter((b) => b.category === category);
      console.log(`\n[${category}] ${list.length}개`);
      for (const b of list.slice(0, 40)) {
        console.log(`  - ${b.label}${b.weekday ? ` (${b.weekday}요일)` : ''} · ${b.body.length}자`);
      }
      if (list.length > 40) console.log(`  … 외 ${list.length - 40}개`);
    }

    // 헤딩은 있는데 카테고리를 못 정한 섹션 — 파서 조정이 필요한지 알려준다
    const headings = doc.markdown.match(/^#{1,6}\s+.+$/gm) || [];
    console.log(`\n전체 헤딩 ${headings.length}개 중 빌드로 분류된 건 ${found.length}개`);
    if (found.length === 0) {
      console.log('\n헤딩 목록 (앞 40개):');
      for (const h of headings.slice(0, 40)) console.log(`  ${h}`);
    }
  } catch (e) {
    console.error(`\n실패: ${e.message}`);
    process.exitCode = 1;
  }
})();
