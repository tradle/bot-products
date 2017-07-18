
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test'
}

const crypto = require('crypto')
const { EventEmitter } = require('events')
const test = require('tape')
const co = require('co').wrap
const shallowExtend = require('xtend/mutable')
const fakeResource = require('@tradle/build-resource/fake')
const buildResource = require('@tradle/build-resource')
const baseModels = require('../base-models')
const createProductsStrategy = require('../')
const ageModels = require('./fixtures/agemodels')
const {
  genEnumModel,
  // genMyProductModel,
  // getApplicationModels
} = require('../utils')

const TYPE = '_t'
const PRODUCT_APPLICATION = 'tradle.ProductApplication'
const CURRENT_ACCOUNT = 'tradle.CurrentAccount'
const FORM_REQ = 'tradle.FormRequest'
const SELF_INTRODUCTION = 'tradle.SelfIntroduction'

const series = co(function* (arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    yield fn(arr[i])
  }
})

test('basic form loop', loudCo(function* (t) {
  let opts
  const handlers = []
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

  const from = 'bill'
  const to = 'ted'
  const appLink = 'some app'
  const productModels = [
    baseModels[CURRENT_ACCOUNT],
    // custom
    {
      type: 'tradle.Model',
      id: 'tradle.TestProduct',
      title: 'Test Product',
      interfaces: ['tradle.ChatItem'],
      subClassOf: 'tradle.FinancialProduct',
      forms: [
        'tradle.ORV',
        'tradle.AboutYou'
      ],
      properties: {}
    }
  ]

  const productsStrategy = createProductsStrategy({
    namespace: 'test.namespace',
    models: toObject(productModels),
    products: productModels.map(model => model.id)
  })

  const productsAPI = productsStrategy.install(bot)
  // productsAPI.use({
  //   onForm: function () {
  //     console.log('onForm', ...arguments)
  //   }
  // })

  const { models } = productsAPI

  let linkCounter = 0
  const user = {
    id: 'bob'
  }

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
    const wait = awaitResponse ? awaitMessageFromProvider() : Promise.resolve()
    yield series(handlers, fn => fn({ user, message, payload, type }))
    return {
      request: message,
      response: yield wait
    }
  })

  const applyForProduct = ({ productModel }) => {
    return receiveFromUser({
      object: {
        [TYPE]: productsStrategy.models.application.id,
        product: {
          id: productModel.id
        }
      },
      context: appLink,
      link: appLink,
      permalink: appLink
    })
  }

  const awaitMessageFromProvider = type => {
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
    const { payload } = yield awaitMessageFromProvider(FORM_REQ)
    t.equal(payload.form, formType)
  })

  const testProduct = co(function* ({ productModel }) {
    let { response } = yield applyForProduct({ productModel })
    const forms = productModel.forms.slice()
    const bad = {
      [forms[0]]: true
    }

    for (let i = 0; i < forms.length; i++) {
      let nextForm = forms[i]
      t.equal(response.object.form, nextForm)
      let result = yield receiveFromUser({
        object: fakeResource({
          models,
          model: models[nextForm]
        }),
        context: appLink
      })

      if (bad[nextForm]) {
        // user corrects form
        productsAPI.requestEdit({
          user,
          object: result.request.object,
          message: 'dude, seriously',
          errors: []
        })

        yield awaitMessageFromProvider('tradle.FormError')
        bad[nextForm] = false
        result = yield receiveFromUser({
          object: fakeResource({
            models,
            model: models[nextForm]
          }),
          context: appLink
        })
      }

      response = result.response
      yield productsAPI.verify({
        user,
        item: result.request.object
      })

      yield awaitMessageFromProvider('tradle.Verification')
      t.ok(nextForm in user.forms)
      t.ok(productModel.id in user.applications)
    }

    // get product cert
    t.equal(response.object[TYPE], productsStrategy.models.certificateForProduct[productModel.id].id)
    t.ok(productModel.id in user.products)
    t.same(user.applications[productModel.id], [])

    yield receiveFromUser({
      object: fakeResource({
        models,
        model: models['tradle.ForgetMe']
      }),
      awaitResponse: false
    })

    productModel.forms.forEach(form => t.notOk(form in user.forms))
  })

  const selfIntroResp = yield receiveFromUser({
    object: fakeResource({
      models,
      model: models[SELF_INTRODUCTION]
    }),
    awaitResponse: true
  })

  for (let productModel of productModels) {
    yield testProduct({ productModel })
  }

  t.end()
}))

test('plugins', loudCo(function* (t) {
  const productModels = [
    baseModels[CURRENT_ACCOUNT]
  ]

  const productsStrategy = createProductsStrategy({
    namespace: 'test.namespace',
    models: toObject(productModels),
    products: productModels.map(model => model.id)
  })

  const bot = {
    use: (strategy, opts) => strategy(bot, opts),
    onmessage: () => {},
    onusercreate: () => {}
  }

  const productsAPI = productsStrategy.install(bot)
  productsAPI.plugins.clear('getRequiredItems')
  productsAPI.plugins.use({
    getRequiredItems: function () {
      return ['blah']
    }
  })

  t.same(productsAPI.getRequiredItems(), ['blah'])

  productsAPI.plugins.clear('getRequiredItems')
  productsAPI.plugins.use({
    getRequiredItems: function () {
      return Promise.resolve(['blah1'])
    }
  })

  t.same(yield productsAPI.getRequiredItems(), ['blah1'])
  t.end()
}))

function toObject (models) {
  const obj = {}
  models.forEach(model => obj[model.id] = model)
  return obj
}

// test('genModels', function (t) {
//   const enumModel = genEnumModel({ models, id: 'my.enum.of.Goodness' })
//   // console.log(JSON.stringify(enumModel, null, 2))
//   t.end()
// })

function fakeMessage ({ from, to, object }) {
  const msgLink = newLink()
  const objLink = newLink()
  if (typeof object === 'string') debugger
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

// process.on('uncaughtException', console.error)
