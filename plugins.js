const assert = require('assert')
const { locate } = require('func-loc');
const { isPromise, bindAll, debug } = require('./utils')
// const TESTING = process.env.NODE_ENV === 'test'

module.exports = function createPluginManager (defaults) {
  return new PluginManager(defaults)
}

function PluginManager (defaults) {
  bindAll(this)
  this._plugins = {}
  if (defaults) this.use(defaults)
}

PluginManager.prototype.register = function register (method, handlers, unshift) {
  handlers = [].concat(handlers).map(wrapHandler)

  assert(
    handlers.every(handler => typeof handler.fn === 'function'),
    'expected wrapped handlers'
  )

  const current = this._plugins[method] || []
  const first = unshift ? handlers : current
  const second = unshift ? current : handlers
  this._plugins[method] = first.concat(second)
  return this.unregister.bind(this, method, handlers)
}

PluginManager.prototype.unregister = function unregister (method, handlers) {
  if (!this._plugins[method]) return

  handlers = [].concat(handlers).map(unwrapHandler)
  this._plugins[method] = this._plugins[method]
    .filter(({ fn }) => !handlers.includes(fn))
}

PluginManager.prototype.use = function use (plugin, unshift) {
  for (let method in plugin) {
    let val = plugin[method]
    if (typeof val === 'function') {
      this.register(method, wrapHandler(val, plugin), unshift)
    } else if (Array.isArray(val) && val.every(sub => typeof sub === 'function')) {
      this.register(method, wrapHandler(val), unshift)
    }
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
  args,
  waterfall,
  returnResult,
  allowExit
}) {
  if (typeof arguments[0] === 'string') {
    method = arguments[0]
    args = Array.prototype.slice.call(arguments, 1)
  }

  const handlers = this._plugins[method] || []
  this._debug(`${handlers.length} handlers found for "${method}"`)
  if (!handlers.length) return Promise.resolve()

  return execute({
    handlers,
    args,
    allowExit,
    returnResult,
    waterfall
  })
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
function execute ({ handlers, args, waterfall, allowExit, returnResult }) {
  let ret
  handlers = handlers.slice()
  while (handlers.length) {
    let handler = handlers.shift()

    const originalHandler = handler
    handler = async function (...args) {
      const start = Date.now()
      const result = await originalHandler.fn.call(originalHandler.context || this, ...args.slice(1))
      let interval = Date.now() - start
      let name, location
      try {
        let fname = await locate(originalHandler.fn);
        // name = fname.path.split('/')
        name = fname
      } catch (err) {
        debugger
      }
      console.log(`plugins.time (${name  && name.path || ''}):`, interval)
      // console.log(`plugins.time (${name  &&  name[name.length - 1]}):`, interval)
      // if (interval > 2000)
      //   debugger
      return result
    }
    ret = handler(originalHandler.context || this, ...args)
    if (isPromise(ret)) {
      return ret.then(continueExec)
    }

    return continueExec(ret)
  }

  function continueExec (ret) {
    if (allowExit && ret === false) return ret
    if (returnResult && ret != null) return ret
    if (!handlers.length) return ret
    if (waterfall) args = [ret]

    return execute({ handlers, args, waterfall, allowExit, returnResult })
  }
}

function wrapHandler (fn, context) {
  return typeof fn === 'function' ? { fn, context } : fn
}

function unwrapHandler (handler) {
  return typeof handler === 'function' ? handler : handler.fn
}
