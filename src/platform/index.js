module.exports = process.platform === 'win32'
  ? require('./windows')
  : require('./mac');
