
module.exports = function logfunctions(obj) {
  Object.keys(obj).forEach(function(key) {
    var fn = obj[key];
    if (typeof fn !== 'function') return;

    obj[key] = function() {
      console.log(key);
      return fn.apply(this, arguments);
    }
  })
}
