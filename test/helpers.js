const crypto = require('crypto')
const { EventEmitter } = require('events')
const _ = require('lodash')
const co = require('co').wrap
const sinon = require('sinon')
const createHooks = require('event-hooks')
const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const fakeResource = require('@tradle/build-resource/fake')
const createProductsStrategy = require('../')
const defaultBotIdentity = require('./fixtures/bot-identity')
const defaultUserIdentity = require('./fixtures/user-identity')
const baseModels = require('../base-models')
const FORM_REQ = 'tradle.FormRequest'
const {
  series
} = require('../utils')

let contextCounter = 0

module.exports = {
  formLoop,
  fakeBot: createFakeBot,
  fakeMessage,
  loudCo,
  newLink,
  newSig,
  toObject,
  hex32,
  // fakeIdentityStub,
  fakeStub
}

function createFakeBot (opts={}) {
  const {
    user,
    botIdentity=defaultBotIdentity
  } = opts

  const botId = botIdentity._permalink
  const byPermalink = {}
  const byLink = {}
  const handlers = []
  const objects = {}
  const hooks = createHooks()
  const bot = _.extend(new EventEmitter(), {
    use: (strategy, opts) => strategy(bot, opts),
    onmessage: handler => handlers.push(handler),
    onusercreate: () => {},
    seal: function ({ link }) {
      if (typeof link !== 'string') {
        return Promise.reject('expected string link')
      }

      return Promise.resolve()
    },
    presignEmbeddedMediaLinks: function (object) {
      return object
    },
    getMyIdentity: co(function* () {
      return botIdentity
    }),
    sign: co(function* (object) {
      object[SIG] = newSig()
      buildResource.setVirtual(object, {
        _author: botId
      })

      return object
    }),
    save: co(function (object) {
      byPermalink[buildResource.permalink(object)] = object
      byLink[buildResource.link(object)] = object
    }),
    send: co(function* (opts) {
      const ret = yield Promise.all([].concat(opts)
        .map(co(function* ({ to, object, other }) {
          object = yield bot.sign(object)
          yield bot.save(object)
          const msg = fakeMessage({ from: botId, to: user.id, object, other })
          process.nextTick(() => bot.emit('sent', msg))
          return msg
        })))

      return Array.isArray(opts) ? ret : ret[0]
    }),
    objects: {
      get: co(function* (link) {
        if (!objects[link]) {
          throw new Error('NotFound')
        }
      }),
      put: co(function* (item) {
        objects[item._link] = item
      })
    },
    db: {
      del: co(function* (primaryKeys) {
        delete byPermalink[primaryKeys._link]
      }),
      deleteAllVersions: co(function* ({ type, permalink }) {
        assert(typeof type === 'string', 'expected string, "type"')
        assert(typeof permalink === 'string', 'expected string, "permalink"')
      }),
      get: co(function* (props) {
        const type = props[TYPE]
        const permalink = props._permalink
        const object = byPermalink[permalink]
        if (!object) {
          throw new Error('NotFound')
        }

        return object
      })
    },
    hooks,
    hook: hooks.hook
  })

  return { bot, handlers }
}

function formLoop ({
  models,
  products,
  userIdentity=defaultUserIdentity,
  botIdentity=defaultBotIdentity,
  introduced
}) {
  let linkCounter = 0
  const productModels = products.map(id => models[id])
  const from = botIdentity._permalink
  const to = userIdentity._permalink
  const user = {
    id: userIdentity._permalink,
    identity: introduced ? buildResource.stub({
      models: baseModels,
      model: 'tradle.Identity',
      resource: userIdentity
    }) : null
  }

  const { bot, handlers } = createFakeBot({ user })
  const productsAPI = createProductsStrategy({
    namespace: 'test.namespace',
    models: {
      all: models
    },
    products: productModels.map(model => model.id)
  })

  productsAPI.install(bot)
  productsAPI.removeDefaultHandler('onFormsCollected')
  const receiveFromUser = co(function* ({
    object,
    context,
    link,
    permalink,
    awaitResponse=true
  }) {
    if (!link) {
      link = permalink = 'link' + (linkCounter++)
    }

    const message = fakeMessage({
      from: to,
      to: from,
      object
    })

    if (context) {
      message.context = context
      buildResource.setVirtual(message, { _context: context })
    }

    const payload = message.object
    const type = payload[TYPE]
    const wait = awaitResponse ? awaitBotResponse() : Promise.resolve()
    yield series(handlers, fn => fn({
      user,
      message,
      payload,
      type,
      permalink: payload._permalink,
      link: payload._link
    }))

    return {
      request: message,
      response: yield wait
    }
  })

  const applyForProduct = ({ productModel }) => {
    const req = buildResource({
        models: productsAPI.models.all,
        model: 'tradle.ProductRequest',
      })
      .set({
        requestFor: productModel.id,
        contextId: 'abcdefgh' + (contextCounter++)
      })
      .toJSON()

    const link = newLink()
    return receiveFromUser({
      object: req,
      context: req.contextId,
      link,
      permalink: link
    })
  }

  const awaitBotResponse = type => {
    return new Promise(resolve => {
      bot.on('sent', checkType)

      function checkType (...args) {
        const { object } = args[0]
        if (!type || object[TYPE] === type) {
          bot.removeListener('sent', checkType)
          resolve(...args)
        }
      }
    })
  }

  const awaitFormRequest = co(function* (formType) {
    const { payload } = yield awaitBotResponse(FORM_REQ)
    if (payload.form !== formType) {
      throw new Error(`expected request for "${formType}"`)
    }
  })

  return {
    bot,
    botIdentity,
    userIdentity,
    api: productsAPI,
    plugins: productsAPI.plugins,
    models: productsAPI.models,
    user,
    awaitBotResponse,
    awaitFormRequest,
    receiveFromUser,
    applyForProduct,
  }
}

function fakeMessage ({ from, to, object, other={} }) {
  const msgLink = newLink()
  const objLink = newLink()
  object = _.extend({
    [SIG]: object[SIG] || newSig(),
    _author: from,
    _link: objLink,
    _permalink: objLink,
    _virtual: ['_author', '_link', '_permalink']
  }, object)

  return _.extend({
    _author: from,
    _recipient: to,
    _link: msgLink,
    _permalink: msgLink,
    [TYPE]: 'tradle.Message',
    [SIG]: newSig(),
    _virtual: ['_author', '_recipient', '_link', '_permalink'],
    object
  }, other)
}

function newLink () {
  return hex32()
}

function newSig () {
  return hex32()
}

function hex32 () {
  return randomHex(32)
}

function randomHex (n) {
  return crypto.randomBytes(n).toString('hex')
}

function loudCo (gen) {
  return co(function* (...args) {
    try {
      return yield co(gen).apply(this, args)
    } catch (err) {
      console.error(err)
      throw err
    }
  })
}

function toObject (models) {
  const obj = {}
  models.forEach(model => obj[model.id] = model)
  return obj
}

function fakeIdentityStub () {
  return fakeStub({
    model: baseModels['tradle.Identity']
  })
}

function fakeStub ({ models=baseModels, model }) {
  return buildResource.stub({
    models,
    resource: fakeResource({
      models,
      model,
      signed: true
    })
  })
}

function assert (statement, errMsg) {
  if (!statement) throw new Error(errMsg)
}
