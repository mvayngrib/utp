var utp = require('../index');
var assert = require('assert');

var closed = 0;
var onclose = function() {
  if (++closed === 2) process.exit(0);
};

utp.createServer(function(socket) {
  socket.resume();
  socket.on('close', onclose);
  socket.end();
}).listen(53454);

var socket = utp.connect(53454);

socket.resume();
socket.on('close', onclose);
socket.on('end', function() {
  socket.end()
});

setTimeout(process.exit.bind(process, 1), 5000);