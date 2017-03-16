const Promise = require('bluebird')
const co = Promise.coroutine
const botUtils = require('@tradle/bots').utils
const STRINGS = require('./strings')

module.exports = {
  Promise,
  co,
  genEnumModel,
  genProductCertificateModel,
  genApplicationModels,
  format,
  parseId,
  wait,
  shallowExtend: botUtils.shallowExtend,
  shallowClone: botUtils.shallowClone
}

function genApplicationModels ({ namespace, models, products }) {
  const productModels = products.map(id => models[id])
  const productList = genEnumModel({
    models: productModels,
    id: `${namespace}.Product`
  })

  const certificates = {}
  const certificateForProduct = {}
  const productForCertificate = {}
  const additional = {}
  productModels.forEach(productModel => {
    const { id } = productModel
    const cert = genProductCertificateModel({ productModel })
    certificates[cert.id] = cert
    productForCertificate[cert.id] = productModel
    additional[cert.id] = cert
    certificateForProduct[id] = cert
  })

  const application = genProductApplicationModel({
    productList,
    id: `${namespace}.ProductApplication`
  })

  const applicationModels = {
    products: productModels,
    productList,
    application,
    certificates,
    certificateForProduct,
    productForCertificate,
    additional
  }

  additional[application.id] = application
  additional[productList.id] = productList
  return applicationModels
}

function genProductApplicationModel ({ productList, id, title }) {
  return normalize({
    type: 'tradle.Model',
    id,
    notShareable: true,
    title: title || STRINGS.AGE_VERIFICATION,
    interfaces: ['tradle.Message'],
    subClassOf: 'tradle.Form',
    properties: {
      product: {
        inlined: true,
        type: 'object',
        displayName: true,
        ref: productList.id
      }
    },
    required: ['product'],
    viewCols: ['product']
  })
}


function genProductCertificateModel ({ productModel, id, title }) {
  // com.example.Furniture => com.example.MyFurniture
  if (!id) {
    id = getCertificateModelId(productModel.id)
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
  const values = Object.keys(models).map(id => {
    const { title } = models[id]
    return { id, title }
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

function getCertificateModelId (productModelId) {
  return productModelId.replace(/\.([^.]+)$/, '.My$1')
}
