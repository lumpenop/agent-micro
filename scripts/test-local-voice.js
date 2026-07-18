#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const whisper = path.join(root, 'assets', 'bin', 'darwin-arm64', 'whisper-cli');
const model = path.join(root, 'assets', 'models', 'ggml-base.bin');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-micro-voice-test-'));
const aiff = path.join(dir, 'sample.aiff');
const wav = path.join(dir, 'sample.wav');
try {
  for (const file of [whisper, model]) if (!fs.existsSync(file)) throw new Error(`missing: ${file}`);
  execFileSync('say', ['-v', 'Yuna', '-o', aiff, '에이전트 마이크 음성 기능 테스트입니다']);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  const text = execFileSync(whisper, ['-ng', '-m', model, '-f', wav, '-l', 'ko', '-nt', '-np'], {
    encoding: 'utf8', timeout: 90000,
  }).trim();
  if (!text) throw new Error('empty transcript');
  console.log(`PASS local voice — ${text}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
