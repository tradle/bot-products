const co = require('co').wrap
const shallowExtend = require('xtend/mutable')
const shallowClone = require('xtend')
const pick = require('object.pick')
const STRINGS = require('./strings')

module.exports = {
  Promise,
  co,
  genEnumModel,
  genProductListModel,
  genProductCertificateModel,
  genProductApplicationModel,
  genApplicationModels,
  format,
  parseId,
  wait,
  shallowExtend,
  shallowClone
}

function genProductListModel ({ namespace, productModels }) {
  return genEnumModel({
    models: productModels,
    id: `${namespace}.Product`
  })
}

function genApplicationModels ({ namespace, models, products }) {
  const productModels = products.map(id => models[id])
  const productList = genProductListModel({ namespace, productModels })
  const certificates = {}
  const certificateForProduct = {}
  const productForCertificate = {}
  const additional = {
    [productList.id]: productList
  }

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

  const all = {}
  const applicationModels = {
    products: productModels,
    productList,
    application,
    certificates,
    certificateForProduct,
    productForCertificate,
    additional,
    all
  }

  additional[application.id] = application
  additional[productList.id] = productList

  getValues(models)
    .concat(productModels)
    .concat(getValues(additional))
    .forEach(model => all[model.id] = model)

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
  const values = models.map(model => pick(model, ['id', 'title']))
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

function getValues (obj) {
  return Object.keys(obj).map(id => obj[id])
}
