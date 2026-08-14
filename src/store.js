const fs = require('node:fs');
const path = require('node:path');

// 봇 설정 저장소 (config.json) - 자동역할 ID, 로그 채널, 읽기 채널 등 명령어로 바꾸는 설정 보관
const configPath = path.join(__dirname, '..', 'config.json');

/**
 * @param {boolean} strict true면 "못 읽음"과 "파일 없음"을 구분해서 던진다.
 *   손상된 파일을 {}로 읽어버리면, 설정 하나 저장하다가 나머지 설정이 통째로 날아간다.
 */
function readConfig(strict) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {}; // 아직 만든 적 없음 — 정상
    if (strict) throw new Error(`config.json을 읽지 못했어요: ${e.message}`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    if (strict) throw new Error('config.json이 손상돼 있어요 — 덮어쓰지 않고 멈춥니다.');
    return {};
  }
}

function get(key) {
  return readConfig(false)[key];
}

/** @returns {boolean} 저장 성공 여부 */
function set(key, value) {
  let config;
  try {
    config = readConfig(true);
  } catch (e) {
    console.warn(`[설정] ${e.message}`);
    return false;
  }

  if (value === null || value === undefined) {
    delete config[key];
  } else {
    config[key] = value;
  }

  // 쓰는 도중에 프로세스가 죽어도 기존 설정이 남도록 임시 파일 → 이름 바꾸기.
  // (설정 하나 저장하다 자동역할·로그 채널까지 통째로 날아가면 안 된다)
  const tmp = `${configPath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, configPath);
    return true;
  } catch (e) {
    console.warn(`[설정] 저장 실패: ${e.message}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 무시 */
    }
    return false;
  }
}

module.exports = { get, set };
