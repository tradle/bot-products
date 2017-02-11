const Promise = require('bluebird')
const co = Promise.coroutine
const STRINGS = require('./strings')

module.exports = {
  Promise,
  co,
  genEnumModel,
  genProductCertificateModel,
  genApplicationModels,
  format,
  parseId,
  wait
}

function genApplicationModels ({ namespace, models }) {
  const productModels = models.filter(model => model.subClassOf === 'tradle.FinancialProduct')
  const productListEnum = genEnumModel({
    models: productModels,
    id: `${namespace}.Product`
  })

  const certificates = productModels.map(productModel => {
    return genProductCertificateModel({ productModel })
  })

  const certificateForProduct = {}
  productModels.forEach((model, i) => {
    certificateForProduct[model.id] = certificates[i]
  })

  const applicationModels = {
    products: productModels,
    productList: productListEnum,
    application: genProductApplicationModel({
      productListEnum,
      id: `${namespace}.ProductApplication`
    }),
    certificates,
    certificateForProduct
  }

  applicationModels.additional = applicationModels.certificates
    .concat(applicationModels.application)
    .concat(applicationModels.productList)

  return applicationModels
}

function genProductApplicationModel ({ productListEnum, id, title }) {
  return normalize({
    type: 'tradle.Model',
    id,
    notShareable: true,
    title: title || STRINGS.AGE_VERIFICATION,
    interfaces: ['tradle.Message'],
    subClassOf: 'tradle.Form',
    properties: {
      product: {
        type: 'object',
        displayName: true,
        ref: productListEnum.id
      }
    },
    required: ['product'],
    viewCols: ['product']
  })
}


function genProductCertificateModel ({ productModel, id, title }) {
  // com.example.Furniture => com.example.MyFurniture
  if (!id) {
    id = productModel.id.replace(/\.([^.]+)$/, '.My$1')
  }

  return normalize({
    type: 'tradle.Model',
    id,
    subClassOf: 'tradle.MyProduct',
    title: title || `My ${productModel.title}`,
    interfaces: [
      "tradle.Message"
    ],
    properties: {
      myProductId: {
        type: 'string'
      }
    },
    required: ['myProductId'],
    viewCols: ['myProductId']
  })
}

function genEnumModel ({ models, id, title }) {
  const values = models.map(model => {
    return {
      id: model.id,
      title: model.title
    }
  })

  return normalize({
    type: 'tradle.Model',
    id,
    title,
    subClassOf: 'tradle.Enum',
    properties: {
      product: {
        type: 'string',
        displayName: true
      }
    },
    enum: values,
    required: ['product'],
    viewCols: ['product']
  })
}

// source: http://stackoverflow.com/questions/610406/javascript-equivalent-to-printf-string-format
function format (str, ...args) {
  return str.replace(/{(\d+)}/g, function (match, number) {
    return typeof args[number] === 'undefined'
      ? match
      : args[number]
    ;
  })
}

function humanize (id) {
  const last = id.split('.').pop()
  const parts = splitCamelCase(last).join(' ')
  return parts[0].toUpperCase() + parts.slice(1)
}

function splitCamelCase (str) {
  return str.split(/(?=[A-Z])/g)
}

function normalize (model) {
  if (!model.title) model.title = humanize(model.id)

  return model
}

function parseId (id) {
  const [type, permalink, link] = id.split('_')
  return {
    type,
    permalink,
    link
  }
}

function wait (millis) {
  return new Promise(resolve => setTimeout(resolve, millis))
}
