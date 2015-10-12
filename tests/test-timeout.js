var utp = require('../index')

var count = 0
var ontimeout = function () {
  if (++count === 2) {
    process.exit(0)
  }
}

utp.createServer(function(socket) {
  socket.resume()
  socket.on('end', function() {
    socket.end()
  })
}).listen(53454)

var socket = utp.connect(53454)
socket.setTimeout(500, ontimeout)
socket.once('timeout', ontimeout)
socket.resume()
socket.write(new Buffer('yo'))

setTimeout(process.exit.bind(process, 1), 5000)
