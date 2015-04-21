var utp = require('../index');
var assert = require('assert');
var closed = 0;
var sockets = [];
var onclose = function() {
  debugger;
  if (++closed === 3) process.exit(0);
};

var server = utp.createServer(function(socket) {
  sockets.push(socket);
  socket.resume();
  socket.on('end', function() {
    socket.end();
  });
  socket.on('close', onclose);
})

server.listen(53454);

var socket = utp.connect(53454);

sockets.push(socket);
socket.resume();
socket.on('connect', function() {
  server.close(onclose);
})
socket.on('close', onclose);
socket.on('end', function() {
  socket.end();
});

setTimeout(process.exit.bind(process, 1), 15000);
