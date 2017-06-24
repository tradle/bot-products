
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test'
}

const crypto = require('crypto')
const { EventEmitter } = require('events')
const test = require('tape')
const co = require('co').wrap
const shallowExtend = require('xtend/mutable')
const fakeResource = require('@tradle/build-resource/fake')
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
      const ret = fakeWrapper({ from, to, object })
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
      interfaces: ['tradle.Message'],
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
  const { models } = productsAPI

  let linkCounter = 0
  const user = {
    id: 'bob'
  }

  const receive = co(function* (object, context=appLink, link, permalink) {
    if (!link) {
      link = permalink = 'link' + (linkCounter++)
    }

    const wrapper = fakeWrapper({
      from: to,
      to: from,
      object
    })

    wrapper.message.context = context

    yield series(handlers, fn => fn({ user, wrapper }))
    return wrapper
  })

  for (let productModel of productModels) {
    // don't wait for this to complete
    let promiseReceive = receive({
      [TYPE]: productsStrategy.models.application.id,
      product: {
        id: productModel.id
      }
    }, appLink, appLink, appLink)

    const forms = productModel.forms.slice()
    for (let i = 0; i < forms.length; i++) {
      let nextForm = forms[i]
      yield new Promise(resolve => {
        bot.once('sent', function ({ message, payload }) {
          const { object, type } = payload
          t.equal(type, FORM_REQ)
          t.equal(object.form, nextForm)
          if (i) {
            t.ok(forms[i - 1] in user.forms)
          }

          t.ok(productModel.id in user.applications)
          resolve()
        })
      })

      let sent = yield promiseReceive
      if (i) {
        // get verification
        productsAPI.verify({
          user,
          item: sent.payload
        })
        .catch(console.error)

        yield new Promise(resolve => {
          bot.once('sent', function ({ message, payload }) {
            t.equal(payload.type, 'tradle.Verification')
            resolve()
          })
        })
      }

      promiseReceive = receive(fakeResource({
        models,
        model: models[nextForm]
      }))
    }

    // get product cert
    yield new Promise(resolve => {
      bot.once('sent', function ({ payload }) {
        const { type } = payload
        const certModel = productsStrategy.models.certificateForProduct[productModel.id]
        t.equal(type, certModel.id)
        t.ok(productModel.id in user.products)
        t.same(user.applications[productModel.id], [])
        resolve()
      })
    })

    yield receive(fakeResource({
      models,
      model: models['tradle.ForgetMe']
    }))

    productModel.forms.forEach(form => t.notOk(form in user.forms))

    // yield new Promise(resolve => {
    //   bot.once('sent', function ({ payload }) {
    //     t.equal(payload.type, 'tradle.ForgotYou')
    //     resolve()
    //   })
    // })
  }

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

function fakeWrapper ({ from, to, object }) {
  object = shallowExtend({
    _s: object._s || newSig()
  }, object)

  const msgLink = newLink()
  const objLink = newLink()
  return {
    message: {
      author: from,
      recipient: to,
      link: msgLink,
      permalink: msgLink,
      object: {
        _t: 'tradle.Message',
        _s: newSig(),
        object
      }
    },
    payload: {
      author: from,
      link: objLink,
      permalink: objLink,
      object,
      type: object[TYPE]
    }
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
