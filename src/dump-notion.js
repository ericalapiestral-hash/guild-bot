// 노션 도감이 실제로 어떤 구조인지 눈으로 확인하는 점검용 스크립트.
//   npm run notion:dump
// data/notion-dump.md 에 읽어온 마크다운 전체를 저장하고, 인식된 빌드 목록을 출력한다.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { fetchCatalog, fetchDocument } = require('./notion');
const { buildsFromCatalog, buildsFromMarkdown } = require('./builds');

(async () => {
  try {
    const pageId = process.env.NOTION_PAGE_ID;
    if (!pageId) throw new Error('NOTION_PAGE_ID가 없어요. .env를 확인해주세요.');

    console.log('노션에서 도감을 읽는 중... (수십 초 걸릴 수 있어요)');

    const catalog = await fetchCatalog(pageId);
    let found = [];
    let dump = '';
    let title = '';

    if (catalog && catalog.builds.length > 0) {
      console.log(`\n구조: 데이터베이스 · 빌드 페이지 ${catalog.pageCount}개`);
      found = buildsFromCatalog(catalog);
      title = catalog.title;
      dump = catalog.builds
        .map((b) => `# ${[...b.groupPath, b.name].join(' › ')}\n\n${b.markdown}`)
        .join('\n\n---\n\n');
    } else {
      const doc = await fetchDocument(pageId);
      console.log(`\n구조: 헤딩 · 페이지 ${doc.pageCount}개`);
      found = buildsFromMarkdown(doc.markdown, { pageUrl: doc.pageUrl });
      title = doc.title;
      dump = doc.markdown;
    }

    const outDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'notion-dump.md');
    fs.writeFileSync(outPath, dump, 'utf8');

    console.log(`제목: ${title}`);
    console.log(`원본 ${dump.length.toLocaleString('ko-KR')}자 · 저장: ${outPath}`);
    console.log(`\n인식된 빌드 ${found.length}개`);

    const groups = new Map();
    for (const b of found) {
      const key = b.group || '(묶음 없음)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }

    for (const [group, list] of groups) {
      const cat = list[0].category;
      console.log(`\n[${group}] ${list.length}개 → 카테고리: ${cat || '미분류 (명령어에 안 잡힘)'}`);
      for (const b of list.slice(0, 40)) {
        const days = b.weekdays && b.weekdays.length ? ` (${b.weekdays.join('·')}요일)` : '';
        console.log(`  - ${b.name}${days} · 본문 ${b.body.length}자`);
      }
      if (list.length > 40) console.log(`  … 외 ${list.length - 40}개`);
    }

    const unmatched = found.filter((b) => !b.category);
    if (unmatched.length > 0) {
      console.log(
        `\n⚠️ ${unmatched.length}개는 공성전·파괴신 어디에도 안 잡혀요 (명령어로 검색되지 않음)`,
      );
    }
  } catch (e) {
    console.error(`\n실패: ${e.message}`);
    process.exitCode = 1;
  }
})();
