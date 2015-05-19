
var utp = require('./')
var togo = 5
utp.createServer(function(c) {
  var cid = setInterval(function() {
    if (--togo > 0) c.write('yo')
    else clearInterval(cid)
  }, 1000)
}).listen(12345)

var s = utp.connect(12345)
var sid = setInterval(function() {
  if (--togo > 0) s.write('yo')
  else clearInterval(sid)
}, 1000)
