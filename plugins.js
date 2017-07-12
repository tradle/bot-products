const { co, isPromise, bindAll } = require('./utils')

module.exports = function createPluginManager (defaults) {
  return new PluginManager(defaults)
}

function PluginManager (defaults) {
  bindAll(this)
  this._plugins = {}
  if (defaults) this.use(defaults)
}

PluginManager.prototype.register = function register (method, handlers) {
  this._plugins[method] = (this._plugins[method] || []).concat(handlers)
  return this.unregister.bind(this, ...arguments)
}

PluginManager.prototype.unregister = function unregister (method, handler) {
  if (!this._plugins[method]) return

  this._plugins[method] = this._plugins[method].filter(fn => fn !== handler)
}

PluginManager.prototype.use = function use (plugin) {
  if (arguments.length > 1) {
    return this.register(...arguments)
  }

  for (let method in plugin) {
    this.register(method, plugin[method])
  }

  return this.unregister.bind(this, ...arguments)
}

PluginManager.prototype.remove = function remove (plugin) {
  if (arguments.length > 1) {
    return this.unregister(...arguments)
  }

  for (let method in plugin) {
    this.unregister(method, plugin[method])
  }
}

PluginManager.prototype.exec = co(function* ({
  method,
  args,
  waterfall,
  allowExit
}) {
  if (typeof arguments[0] === 'string') {
    method = arguments[0]
    args = Array.prototype.slice.call(arguments, 1)
  }

  const handlers = this._plugins[method]
  if (!handlers) return

  let ret
  for (const handler of handlers) {
    ret = handler.apply(this, args)
    if (isPromise(ret)) ret = yield ret
    if (allowExit && ret === false) return ret
    if (waterfall) args = [ret]
  }

  return ret
})
