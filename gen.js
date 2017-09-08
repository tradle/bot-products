
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

function getCertificateModelId ({ productModel }) {
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
  // const ids = getNamespaceIds(namespace)

  const productModels = products.map(id => models[id])
  const productListId = GenId.productList({ namespace })
  const productList = GenModel.productList({
    id: productListId,
    productModels
  })

  const certificates = {}
  const certificateFor = {}
  const productForCertificate = {}
  const additional = {
    [productListId]: productList
  }

  productModels.forEach(productModel => {
    const { id } = productModel
    const certId = GenId.certificate({ productModel })
    const cert = models[certId] || GenModel.certificate({ productModel })
    certificates[certId] = cert
    productForCertificate[certId] = productModel
    certificateFor[id] = cert
    if (!(certId in models)) {
      additional[certId] = cert
    }
  })

  const productRequest = GenModel.productRequest({
    productList,
    id: GenId.productRequest({ namespace })
  })

  const all = {}
  const applicationModels = {
    get products() {
      return productList.enum.map(val => val.id)
    },
    productList,
    productRequest,
    certificates,
    certificateFor,
    productForCertificate,
    additional,
    all
  }

  additional[productRequest.id] = productRequest
  additional[productList.id] = productList

  getValues(models)
    .concat(productModels)
    .concat(getValues(additional))
    .forEach(model => all[model.id] = model)

  return applicationModels
}

function genProductRequestModel ({ productList, id, title }) {
  return normalize({
    type: 'tradle.Model',
    id,
    notShareable: true,
    title: title || idToTitle(id),
    interfaces: ['tradle.Message'],
    subClassOf: 'tradle.Form',
    properties: {
      requestFor: {
        inlined: true,
        type: 'object',
        displayName: true,
        ref: productList.id
      }
    },
    required: ['requestFor'],
    viewCols: ['requestFor']
  })
}


function genCertificateModel ({ productModel, id, title }) {
  // com.example.Furniture => com.example.MyFurniture
  if (!id) {
    id = GenId.certificate({ productModel })
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
  productRequest: ({ namespace }) => `${namespace}.ProductRequest`,
  certificate: getCertificateModelId
}

const GenModel = {
  productList: genProductListModel,
  productRequest: genProductRequestModel,
  certificate: genCertificateModel
}

module.exports = {
  id: GenId,
  model: GenModel,
  applicationModels: genApplicationModels
}
