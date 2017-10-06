const crypto = require('crypto')
const { EventEmitter } = require('events')
const co = require('co').wrap
const shallowExtend = require('xtend/mutable')
const sinon = require('sinon')
const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const fakeResource = require('@tradle/build-resource/fake')
const createProductsStrategy = require('../')
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
  createIdentityStub,
  createStub
}

function createFakeBot () {
  const user = {
    id: 'bill'
  }

  const botId = 'ted'
  const byPermalink = {}
  const byLink = {}
  const handlers = []
  const bot = shallowExtend(new EventEmitter(), {
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
    sign: co(function* (object) {
      object[SIG] = newSig()
      return object
    }),
    save: co(function (object) {
      byPermalink[buildResource.permalink(object)] = object
      byLink[buildResource.link(object)] = object
    }),
    send: co(function* ({ to, object, other }) {
      object = yield bot.sign(object)
      yield bot.save(object)
      const ret = fakeMessage({ from: botId, to: user.id, object, other })
      process.nextTick(() => bot.emit('sent', ret))
      return ret
    }),
    db: {
      latest: co(function* (props) {
        const type = props[TYPE]
        const permalink = props._permalink
        const object = byPermalink[permalink]
        if (!object) {
          throw new Error('NotFound')
        }

        return object
      })
    }
  })

  return { bot, handlers }
}

function formLoop ({ models, products }) {
  let linkCounter = 0
  const productModels = products.map(id => models[id])
  const from = 'bill'
  const to = 'ted'
  const user = {
    id: to
  }

  const { bot, handlers } = createFakeBot()
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

    const payload = message.object
    if (context) {
      buildResource.setVirtual(message, { _context: context })
    }

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
  object = shallowExtend({
    [SIG]: object[SIG] || newSig(),
    _author: from,
    _link: objLink,
    _permalink: objLink,
    _virtual: ['_author', '_link', '_permalink']
  }, object)

  return shallowExtend({
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

function createIdentityStub () {
  return createStub({
    model: baseModels['tradle.Identity']
  })
}

function createStub ({ models=baseModels, model }) {
  return buildResource.stub({
    models,
    resource: fakeResource({
      models,
      model,
      signed: true
    })
  })
}
