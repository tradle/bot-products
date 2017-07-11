const co = require('co').wrap
const shallowExtend = require('xtend/mutable')
const shallowClone = require('xtend')
const pick = require('object.pick')
const STRINGS = require('./strings')

// function getNamespaceIds (namespace) {
//   return {
//     productList: getProductListModelId(namespace),
//     productApplication: getProductApplicationModelId(namespace)
//   }
// }

const GenId = {
  productList: ({ namespace }) => `${namespace}.Product`,
  productApplication: ({ namespace }) => `${namespace}.ProductApplication`,
  productCertificate: getProductCertificateModelId
}

const GenModel = {
  productList: genProductListModel,
  productApplication: genProductApplicationModel,
  productCertificate: genProductCertificateModel
}

// function getProductListModelId (namespace) {
//   return `${namespace}.Product`
// }

// function getProductApplicationModelId (namespace) {
//   return `${namespace}.ProductApplication`
// }

function getProductCertificateModelId ({ productModel }) {
  const id = productModel.id || productModel
  const lastIdx = id.lastIndexOf('.')
  return `${id.slice(0, lastIdx)}.My${id.slice(lastIdx + 1)}`
}

function genProductListModel ({ id, productModels }) {
  return genEnumModel({
    models: productModels,
    id
  })
}

function genApplicationModels ({ namespace, models, products }) {
  const additional = {}
  // const ids = getNamespaceIds(namespace)

  const productModels = products.map(id => models[id])
  const productListId = GenId.productList({ namespace })

  let productList
  if (!(productListId in models)) {
    productList = GenModel.productList({
      id: productListId,
      productModels
    })

    additional[productListId] = productList
  }

  const certificates = {}
  const certificateForProduct = {}
  const productForCertificate = {}

  productModels.forEach(productModel => {
    const { id } = productModel
    const certId = GenId.productCertificate({ productModel })
    const cert = models[certId] || GenModel.productCertificate({ productModel })
    certificates[certId] = cert
    productForCertificate[certId] = productModel
    certificateForProduct[id] = cert
    if (!(certId in models)) {
      additional[certId] = cert
    }
  })

  const application = GenModel.productApplication({
    productList,
    id: GenId.productApplication(namespace)
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
    title: title || idToTitle(id),
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
    id = GenId.productCertificate({ productModel })
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

function getValues (obj) {
  return Object.keys(obj).map(id => obj[id])
}

function idToTitle (id) {
  const camel = id.split('.').pop()
  return splitCamelCase(camel).join(' ')
}

module.exports = {
  gen: {
    id: GenId,
    model: GenModel,
    applicationModels: genApplicationModels
  },
  co,
  // genEnumModel,
  // genProductListModel,
  // genProductCertificateModel,
  // genProductApplicationModel,
  // genApplicationModels,
  format,
  parseId,
  wait,
  shallowExtend,
  shallowClone
}
