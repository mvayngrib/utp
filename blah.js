
var utp = require('./')

var conn = utp.connect({
  port: 12345,
  host: '54.236.214.150',
  localPort: 12345
})

conn.on('data', function(data) {
  console.log('server', data.toString())
})

conn.on('error', console.log)

var server = utp.createServer(function(c) {
  c.on('data', function(data) {
    console.log('client', data.toString())
    c.write(data)
  })
}).listen(conn.socket)