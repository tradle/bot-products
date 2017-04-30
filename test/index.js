
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test'
}

const test = require('tape')
const Promise = require('bluebird')
const co = Promise.coroutine
const rawCreateBot = require('@tradle/bots').bot
const buildResource = require('@tradle/build-resource')
const baseModels = require('@tradle/models/models')
const createProductsStrategy = require('../')
const models = require('./fixtures/agemodels')
const {
  genEnumModel,
  // genMyProductModel,
  // getApplicationModels
} = require('../utils')

const { fakeWrapper } = require('@tradle/bots/test/utils')
const TYPE = '_t'
const PRODUCT_APPLICATION = 'tradle.ProductApplication'
const CURRENT_ACCOUNT = 'tradle.CurrentAccount'
const FORM_REQ = 'tradle.FormRequest'

function createBot (opts) {
  opts.inMemory = true
  return rawCreateBot(opts)
}

const series = co(function* (arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    yield fn(arr[i])
  }
})

test('basic form loop', co(function* (t) {
  const bot = createBot({
    send: co(function* send ({ userId, object }) {
      return fakeWrapper({ from, to, object })
    })
  })

  const from = 'bill'
  const to = 'ted'
  const appLink = 'some app'
  const productModels = [
    // built-in
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

  bot.use(productsStrategy)
  series(productModels, co(function* (productModel) {
    receive({
      [TYPE]: productsStrategy.models.application.id,
      product: {
        id: productModel.id
      }
    }, appLink, appLink, appLink)

    const formsTogo = productModel.forms.slice()
    while (formsTogo.length) {
      let nextForm = formsTogo.shift()
      yield new Promise(resolve => {
        bot.once('sent', function ({ user, type, wrapper }) {
          const { object } = wrapper.message
          t.equal(type, FORM_REQ)
          t.equal(object.form, nextForm)
          resolve()
        })
      })

      receive({
        [TYPE]: nextForm
      })
    }

    // get product cert
    yield new Promise(resolve => {
      bot.once('sent', function ({ user, type }) {
        const certModel = productsStrategy.models.certificateForProduct[productModel.id]
        t.equal(type, certModel.id)
        resolve()
      })
    })

    receive({
      [TYPE]: 'tradle.ForgetMe'
    })

    yield new Promise(resolve => {
      bot.once('sent', function ({ user, type }) {
        t.equal(type, 'tradle.ForgotYou')
        resolve()
      })
    })
  }))

  t.end()

  let linkCounter = 0
  function receive (object, context=appLink, link, permalink) {
    if (!link) {
      link = permalink = 'link' + (linkCounter++)
    }

    const wrapper = fakeWrapper({
      from: to,
      to: from,
      object
    })

    wrapper.message.context = context

    bot.receive(wrapper)

    return new Promise(resolve => {
      bot.once('message', resolve)
    })
  }
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
