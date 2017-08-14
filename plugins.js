const { co, isPromise, bindAll, debug } = require('./utils')

module.exports = function createPluginManager (defaults) {
  return new PluginManager(defaults)
}

function PluginManager (defaults) {
  bindAll(this)
  this._plugins = {}
  if (defaults) this.use(defaults)
}

PluginManager.prototype.register = function register (method, handlers, unshift) {
  handlers = [].concat(handlers)
  const current = this._plugins[method] || []
  const first = unshift ? handlers : current
  const second = unshift ? current : handlers
  this._plugins[method] = first.concat(second)
  return this.unregister.bind(this, method, handlers)
}

PluginManager.prototype.unregister = function unregister (method, handler) {
  if (!this._plugins[method]) return

  this._plugins[method] = this._plugins[method].filter(fn => fn !== handler)
}

PluginManager.prototype.use = function use (plugin, unshift) {
  for (let method in plugin) {
    this.register(method, plugin[method], unshift)
  }

  return this.remove.bind(this, plugin)
}

PluginManager.prototype.clear = function clear (method) {
  if (method) {
    this._plugins[method] = []
  } else {
    this._plugins = {}
  }
}

PluginManager.prototype.remove = function remove (plugin) {
  for (let method in plugin) {
    this.unregister(method, plugin[method])
  }
}

PluginManager.prototype.exec = function ({
  method,
  context=this._defaultContext,
  args,
  waterfall,
  returnResult,
  allowExit
}) {
  if (!context) debugger
  if (typeof arguments[0] === 'string') {
    method = arguments[0]
    args = Array.prototype.slice.call(arguments, 1)
  }

  const handlers = this._plugins[method] || []
  this._debug(`${handlers.length} handlers found for "${method}"`)
  if (!handlers.length) return Promise.resolve()

  return execute({
    fns: handlers,
    context,
    args,
    allowExit,
    returnResult,
    waterfall
  })
}

PluginManager.prototype.setContext = function (context) {
  this._defaultContext = context
}

PluginManager.prototype.count = function (method) {
  if (method) {
    return Object.keys(this._plugins[method])
  }

  return Object.keys(this._plugins).reduce((total, method) => {
    return total + this.count(method)
  }, 0)
}

PluginManager.prototype._debug = function (...args) {
  args.unshift('plugins')
  return debug(...args)
}

/**
 * execute in series, with synchronous and promise support
 */
function execute ({ fns, context, args, waterfall, allowExit, returnResult }) {
  let ret
  fns = fns.slice()
  while (fns.length) {
    let fn = fns.shift()
    if (context) {
      ret = fn.apply(context, args)
    } else {
      ret = fn(...args)
    }

    if (isPromise(ret)) {
      return ret.then(continueExec)
    }

    return continueExec(ret)
  }

  function continueExec (ret) {
    if (allowExit && ret === false) return ret
    if (returnResult && ret != null) return ret
    if (!fns.length) return ret
    if (waterfall) args = [ret]

    return execute({ fns, context, args, waterfall, allowExit, returnResult })
  }
}
