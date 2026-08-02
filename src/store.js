const fs = require('node:fs');
const path = require('node:path');

// 봇 설정 저장소 (config.json) - 자동역할 ID 등 명령어로 바꾸는 설정 보관
const configPath = path.join(__dirname, '..', 'config.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  const config = load();
  if (value === null || value === undefined) {
    delete config[key];
  } else {
    config[key] = value;
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

module.exports = { get, set };
