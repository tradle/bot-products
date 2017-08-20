
const {
  pick,
  splitCamelCase,
  getValues
} = require('./utils')

function humanize (id) {
  const last = id.split('.').pop()
  const parts = splitCamelCase(last).join(' ')
  return parts[0].toUpperCase() + parts.slice(1)
}

function normalize (model) {
  if (!model.title) model.title = humanize(model.id)

  return model
}

function idToTitle (id) {
  const camel = id.split('.').pop()
  return splitCamelCase(camel).join(' ')
}

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
    id: GenId.productApplication({ namespace })
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
    interfaces: ['tradle.Message'],
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

module.exports = {
  id: GenId,
  model: GenModel,
  applicationModels: genApplicationModels
}
