/* eslint-disable func-names */

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test'
}

const test = require('tape')
const Promise = require('bluebird')
const baseModels = require('../base-models')
const createProductsStrategy = require('../')

const CURRENT_ACCOUNT = 'tradle.CurrentAccount'
const {
  loudCo,
  fakeBot,
  // createIdentityStub
} = require('./helpers')

const namespace = 'test.namespace'
const TEST_PRODUCT = {
  type: 'tradle.Model',
  id: `${namespace}.TestProduct`,
  title: 'Test Product',
  subClassOf: 'tradle.FinancialProduct',
  forms: [
    'tradle.ORV',
    'tradle.AboutYou'
  ],
  properties: {}
}

const TEST_MYPRODUCT = {
  type: 'tradle.Model',
  id: `${namespace}.MyTestProduct`,
  title: 'Test My Product',
  subClassOf: 'tradle.MyProduct',
  properties: {}
}

const customModels = {
  [TEST_PRODUCT.id]: TEST_PRODUCT,
  [TEST_MYPRODUCT.id]: TEST_MYPRODUCT
}

test(
  "plugins",
  loudCo(function* (t) {
    const productModels = [baseModels[CURRENT_ACCOUNT]];

    const bot = fakeBot();
    const productsAPI = createProductsStrategy({
      bot,
      models: {
        all: customModels,
      },
      products: productModels.map((model) => model.id),
    });

    productsAPI.plugins.clear("getRequiredForms");
    const custom = {
      blah: 1,
      getRequiredForms: function () {
        t.equal(this.blah, 1, "context preserved");
        return ["blah"];
      },
      doABC: [function doABC1() {}, function doABC2() {}],
    };

    productsAPI.plugins.use(custom);

    t.same(productsAPI.plugins.exec("getRequiredForms"), ["blah"]);

    productsAPI.plugins.clear("getRequiredForms");
    productsAPI.plugins.use({
      getRequiredForms: function () {
        return Promise.resolve(["blah1"]);
      },
    });

    t.same(yield productsAPI.plugins.exec("getRequiredForms"), ["blah1"]);

    productsAPI.removeDefaultHandlers();
    t.same(productsAPI.plugins._plugins["onmessage:tradle.Form"], []);

    t.end();
  })
);
