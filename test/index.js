
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test'
}

const test = require('tape')
const co = require('co').wrap
const shallowExtend = require('xtend/mutable')
const fakeResource = require('@tradle/build-resource/fake')
const buildResource = require('@tradle/build-resource')
const mergeModels = require('@tradle/merge-models')
const { TYPE } = require('@tradle/constants')
const baseModels = require('../base-models')
const createProductsStrategy = require('../')
const ageModels = require('./fixtures/agemodels')
const {
  genEnumModel,
  // genMyProductModel,
  // getApplicationModels
} = require('../utils')

const PRODUCT_APPLICATION = 'tradle.ProductApplication'
const CURRENT_ACCOUNT = 'tradle.CurrentAccount'
const SELF_INTRODUCTION = 'tradle.SelfIntroduction'
const { formLoop, loudCo, toObject } = require('./helpers')

test('basic form loop', loudCo(function* (t) {
  const products = [CURRENT_ACCOUNT, 'tradle.TestProduct']
  const {
    bot,
    api,
    applyForProduct,
    awaitBotResponse,
    receiveFromUser,
    plugins,
    models,
    appModels,
    user
  } = formLoop({
    products,
    models: mergeModels()
      .add(baseModels)
      .add([{
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
      }])
      .get()
  })

  const productModels = products.map(id => models[id])
  const pluginsCalled = {
    onForm: {},
    onFormsCollected: {}
  }

  plugins.use({
    onForm: function ({ type }) {
      pluginsCalled.onForm[type] = (pluginsCalled.onForm[type] || 0) + 1
    },
    onFormsCollected: function ({ application }) {
      t.notOk(pluginsCalled.onFormsCollected[application.type])
      pluginsCalled.onFormsCollected[application.type] = true
    },
    // validateForm: function ({ application, form }) {
    //   console.log(application, form)
    // }
  })

  const testProduct = co(function* ({ productModel }) {
    pluginsCalled.onForm = {}
    pluginsCalled.onFormsCollected = {}

    let { request, response } = yield applyForProduct({ productModel })
    const { context } = request
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
        context
      })

      if (bad[nextForm]) {
        // user corrects form
        api.requestEdit({
          user,
          object: result.request.object,
          message: 'dude, seriously',
          errors: []
        })

        yield awaitBotResponse('tradle.FormError')
        bad[nextForm] = false
        result = yield receiveFromUser({
          object: fakeResource({
            models,
            model: models[nextForm]
          }),
          context
        })
      }

      response = result.response
      yield api.verify({
        user,
        item: result.request.object
      })

      yield awaitBotResponse('tradle.Verification')
      let app = user.applications[productModel.id][0] ||
        user.products[productModel.id][0]

      t.ok(app)
      t.ok(app.forms.some(({ type }) => type === nextForm))
    }

    // get product cert
    t.equal(response.object[TYPE], appModels.certificateForProduct[productModel.id].id)
    t.ok(productModel.id in user.products)
    t.same(user.applications[productModel.id], [])
    productModel.forms.forEach(form => {
      t.equal(pluginsCalled.onForm[form], form in bad ? 2 : 1)
    })

    t.same(pluginsCalled.onFormsCollected, {
      [productModel.id]: true
    })

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

// test('genModels', function (t) {
//   const enumModel = genEnumModel({ models, id: 'my.enum.of.Goodness' })
//   // console.log(JSON.stringify(enumModel, null, 2))
//   t.end()
// })
//
// process.on('uncaughtException', console.error)
