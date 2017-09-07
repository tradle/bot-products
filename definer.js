
module.exports = function createLazyDefiner () {
  return function define (property, definer) {
    let value
    Object.defineProperty(this, property, {
      configurable: true,
      get: function () {
        if (value == null) {
          value = definer()
        }

        return value
      },
      set: function (newValue) {
        value = newValue
      }
    })
  }
}
