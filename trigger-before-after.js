
const {
  co,
  isPromise,
  debug
} = require('./utils')


module.exports = addTriggers

/**
 * trigger will{Method} and did{Method} plugins before/after `method`
 * e.g. calling strategy.send() will call plugins for willSend prior
 * to running the underlying strategy.send() implementation, and didSend
 * after strategy.send() is done
 */
function addTriggers (strategy, methods) {
  methods.forEach(method => {
    const orig = strategy[method]
    strategy[method] = co(function* (...args) {
      const beforeMethod = 'will' + upperFirst(method)
      debug(`triggering ${beforeMethod}`)
      const before = this._exec(beforeMethod, ...args)
      if (isPromise(before)) yield before

      let result = orig.call(this, ...args)
      if (isPromise(result)) result = yield result

      const afterArgs = args.concat(result)
      const afterMethod = 'did' + upperFirst(method)
      debug(`triggering ${afterMethod}`)
      const after = this._exec(afterMethod, ...afterArgs)
      if (isPromise(after)) yield after

      return result
    })
  })
}

function upperFirst (str) {
  return str[0].toUpperCase() + str.slice(1)
}
