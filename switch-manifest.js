const fs = require('fs');

const target = process.argv[2]; // 'chrome' 或 'firefox'

const chromeManifest = 'manifest.json';
const firefoxManifest = 'manifest.firefox.json';

if (target === 'firefox') {
  fs.copyFileSync(firefoxManifest, chromeManifest);
  console.log('已切换到 Firefox 版本 manifest');
} else if (target === 'chrome') {
  // 假设你保留了原始的 Chrome manifest 为 manifest.chrome.json
  fs.copyFileSync('manifest.chrome.json', chromeManifest);
  console.log('已切换到 Chrome 版本 manifest');
} else {
  console.log('用法: node switch-manifest.js [chrome|firefox]');
}