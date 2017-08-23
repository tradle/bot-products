const crypto = require('crypto')
const { EventEmitter } = require('events')
const co = require('co').wrap
const shallowExtend = require('xtend/mutable')
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const createProductsStrategy = require('../')
const FORM_REQ = 'tradle.FormRequest'
const {
  series
} = require('../utils')

module.exports = {
  formLoop,
  fakeMessage,
  loudCo,
  newLink,
  newSig,
  toObject
}

function formLoop ({ models, products }) {
  let linkCounter = 0
  const handlers = []
  const productModels = products.map(id => models[id])
  const from = 'bill'
  const to = 'ted'
  const user = {
    id: to
  }

  const bot = shallowExtend(new EventEmitter(), {
    use: (strategy, opts) => strategy(bot, opts),
    onmessage: handler => handlers.push(handler),
    onusercreate: () => {},
    send: co(function* ({ to, object }) {
      const ret = fakeMessage({ from, to, object })
      process.nextTick(() => bot.emit('sent', ret))
      return ret
    })
  })

  const productsStrategy = createProductsStrategy({
    namespace: 'test.namespace',
    models,
    products: productModels.map(model => model.id)
  })

  const productsAPI = productsStrategy.install(bot)
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
    const context = hex32()
    return receiveFromUser({
      object: {
        [TYPE]: productsStrategy.models.application.id,
        product: {
          id: productModel.id
        }
      },
      context,
      link: context,
      permalink: context
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
    appModels: productsAPI.appModels,
    user,
    awaitBotResponse,
    awaitFormRequest,
    receiveFromUser,
    applyForProduct,
  }
}

function fakeMessage ({ from, to, object }) {
  const msgLink = newLink()
  const objLink = newLink()
  object = shallowExtend({
    _s: object._s || newSig(),
    _author: from,
    _link: objLink,
    _permalink: objLink,
    _virtual: ['_author', '_link', '_permalink']
  }, object)

  return {
    _author: from,
    _recipient: to,
    _link: msgLink,
    _permalink: msgLink,
    _t: 'tradle.Message',
    _s: newSig(),
    _virtual: ['_author', '_recipient', '_link', '_permalink'],
    object
  }
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
