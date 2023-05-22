'use strict'
const models = require('../models')
const Order = models.Order
const Product = models.Product
const Restaurant = models.Restaurant
const User = models.User
const moment = require('moment')
const { Op } = require('sequelize')
const { validationResult } = require('express-validator')

const generateFilterWhereClauses = function (req) {
  const filterWhereClauses = []
  if (req.query.status) {
    switch (req.query.status) {
      case 'pending':
        filterWhereClauses.push({
          startedAt: null
        })
        break
      case 'in process':
        filterWhereClauses.push({
          [Op.and]: [
            {
              startedAt: {
                [Op.ne]: null
              }
            },
            { sentAt: null },
            { deliveredAt: null }
          ]
        })
        break
      case 'sent':
        filterWhereClauses.push({
          [Op.and]: [
            {
              sentAt: {
                [Op.ne]: null
              }
            },
            { deliveredAt: null }
          ]
        })
        break
      case 'delivered':
        filterWhereClauses.push({
          sentAt: {
            [Op.ne]: null
          }
        })
        break
    }
  }
  if (req.query.from) {
    const date = moment(req.query.from, 'YYYY-MM-DD', true)
    filterWhereClauses.push({
      createdAt: {
        [Op.gte]: date
      }
    })
  }
  if (req.query.to) {
    const date = moment(req.query.to, 'YYYY-MM-DD', true)
    filterWhereClauses.push({
      createdAt: {
        [Op.lte]: date.add(1, 'days') // FIXME: se pasa al siguiente día a las 00:00
      }
    })
  }
  return filterWhereClauses
}

// Returns :restaurantId orders
exports.indexRestaurant = async function (req, res) {
  const whereClauses = generateFilterWhereClauses(req)
  whereClauses.push({
    restaurantId: req.params.restaurantId
  })
  try {
    const orders = await Order.findAll({
      where: whereClauses,
      include: {
        model: Product,
        as: 'products'
      }
    })
    res.json(orders)
  } catch (err) {
    res.status(500).send(err)
  }
}

// DONE: Implement the indexCustomer function that queries orders from current logged-in customer and send them back.
// Orders have to include products that belongs to each order and restaurant details
// sort them by createdAt date, desc.
exports.indexCustomer = async function (req, res) {
  try {
    const orders = await Order.findAll({
      where: {
        userId: req.user.id
      },
      include: [{
        model: Product,
        as: 'products'
      }, {
        model: Restaurant,
        as: 'restaurant',
        attributes: { exclude: ['createdAt', 'updatedAt'] }
      }],
      order: [['createdAt', 'DESC']]
    })
    res.json(orders)
  } catch (err) {
    res.status(500).send(err)
  }
}

// DONE: Implement the create function that receives a new order and store it at the database.
// Take into account that:
// 1. req.body have to include a products id array that belongs to the order to be created
// 2. If price is greater than 10€, shipping costs have to be 0.
// 3. If price is less or equals to 10€,  shipping costs have to be restaurant default shipping costs and have to be added to the order total price
// 4. In order to save the order and related products, start a transaction, store the order, store each product linea and commit the transaction
// 5. If an exception is raised, catch it and rollback the transaction
exports.create = async function (req, res) {
  const err = validationResult(req)
  if (err.errors.length > 0) {
    res.status(422).send(err)
  } else {
    const transaction = await models.sequelize.transaction()
    try {
      let newOrder = Order.build(req.body)
      newOrder.createdAt = Date.now()
      newOrder.startedAt = null
      newOrder.deliveredAt = null
      newOrder.sentAt = null
      newOrder.userId = req.user.id
      newOrder.products = null

      // Calculamos la segunda condición de la regla de negocio 2
      const restaurant = await Restaurant.findByPk(req.body.restaurantId)
      let precio = 0.0
      for (const product of req.body.products) {
        const databaseProduct = await Product.findByPk(product.productId)
        precio += product.quantity * databaseProduct.price
      }

      if (precio > 10) {
        newOrder.shippingCosts = 0.0
      } else {
        newOrder.shippingCosts = restaurant.shippingCosts
      }
      newOrder.price = precio + newOrder.shippingCosts

      // Transaction
      newOrder = await newOrder.save({ transaction })

      for (const product of req.body.products) {
        const databaseProduct = await Product.findByPk(product.productId)
        await newOrder.addProduct(databaseProduct, {
          through: { quantity: product.quantity, unityPrice: databaseProduct.price },
          transaction
        })
      }

      await transaction.commit()
      await newOrder.reload({ include: [{ model: Product, as: 'products' }] })
      res.json(newOrder)
    } catch (error) {
      if (error.name.includes('ValidationError')) {
        res.status(422).send(error)
      } else {
        await transaction.rollback()
        res.status(500).send(error)
      }
    }
  }
}

// TODO: Implement the update function that receives a modified order and persists it in the database.
// Take into account that:
// 1. If price is greater than 10€, shipping costs have to be 0.
// 2. If price is less or equals to 10€, shipping costs have to be restaurant default shipping costs and have to be added to the order total price
// 3. In order to save the updated order and updated products, start a transaction, update the order, remove the old related OrderProducts and store the new product lines, and commit the transaction
// 4. If an exception is raised, catch it and rollback the transaction
exports.update = async function (req, res) {
  const err = validationResult(req)
  if (err.errors.length > 0) {
    res.status(422).send(err)
  } else {
    const transaction = await models.sequelize.transaction()
    const restaurant = await Restaurant.findByPk(req.body.restaurantId)
    let totalPrice = 0.0
    for (const product of req.body.products) {
      const databaseProduct = await Product.findByPk(product.productId)
      totalPrice += product.quantity * databaseProduct.price
    }

    let shippingCosts = 0
    if (totalPrice <= 10.0) {
      shippingCosts = restaurant.shippingCosts
    }

    req.body.price = totalPrice + shippingCosts
    req.body.shippingCosts = shippingCosts
    let updatedOrder = await Order.findByPk(req.params.orderId)
    try {
      await Order.update(req.body, { where: { id: req.params.orderId } }, { transaction })
      await updatedOrder.setProducts([], { transaction })
      for (const product of req.body.products) {
        const databaseProduct = await Product.findByPk(product.productId)
        await updatedOrder.addProduct(databaseProduct, {
          through: { quantity: product.quantity, unityPrice: databaseProduct.price },
          transaction
        })
      }
      await transaction.commit()
      updatedOrder = await Order.findByPk(req.params.orderId, { include: [{ model: Product, as: 'products' }] })

      res.json(updatedOrder)
    } catch (error) {
      await transaction.rollback()
      res.status(500).send(error)
    }
  }
}

// TODO: Implement the destroy function that receives an orderId as path param and removes the associated order from the database.
// Take into account that:
// 1. The migration include the "ON DELETE CASCADE" directive so OrderProducts related to this order will be automatically removed.
exports.destroy = async function (req, res) {
  const err = validationResult(req)
  if (err.errors.length > 0) {
    res.status(422).send(err)
  } else {
    try {
      const result = await Order.destroy({ where: { id: req.params.orderId } })
      let message = ''
      if (result === 1) {
        message = 'Order id ' + req.params.orderId + ' has been successfully deleted.' +
        res.json(message)
      } else {
        message = 'Could not delete order.'
        res.status(422).json({ message })
      }
    } catch (err) {
      res.status(500).send(err)
    }
  }
}

exports.confirm = async function (req, res) {
  try {
    const order = await Order.findByPk(req.params.orderId)
    order.startedAt = new Date()
    const updatedOrder = await order.save()
    res.json(updatedOrder)
  } catch (err) {
    res.status(500).send(err)
  }
}

exports.send = async function (req, res) {
  try {
    const order = await Order.findByPk(req.params.orderId)
    order.sentAt = new Date()
    const updatedOrder = await order.save()
    res.json(updatedOrder)
  } catch (err) {
    res.status(500).send(err)
  }
}

exports.deliver = async function (req, res) {
  try {
    const order = await Order.findByPk(req.params.orderId)
    order.deliveredAt = new Date()
    const updatedOrder = await order.save()
    const restaurant = await Restaurant.findByPk(order.restaurantId)
    const averageServiceTime = await restaurant.getAverageServiceTime()
    await Restaurant.update({ averageServiceMinutes: averageServiceTime }, { where: { id: order.restaurantId } })
    res.json(updatedOrder)
  } catch (err) {
    res.status(500).send(err)
  }
}

exports.show = async function (req, res) {
  try {
    const order = await Order.findByPk(req.params.orderId, {
      include: [{
        model: Restaurant,
        as: 'restaurant',
        attributes: ['name', 'description', 'address', 'postalCode', 'url', 'shippingCosts', 'averageServiceMinutes', 'email', 'phone', 'logo', 'heroImage', 'status', 'restaurantCategoryId']
      },
      {
        model: User,
        as: 'user',
        attributes: ['firstName', 'email', 'avatar', 'userType']
      },
      {
        model: Product,
        as: 'products'
      }]
    })
    res.json(order)
  } catch (err) {
    res.status(500).send(err)
  }
}

exports.analytics = async function (req, res) {
  const yesterdayZeroHours = moment().subtract(1, 'days').set({ hour: 0, minute: 0, second: 0, millisecond: 0 })
  const todayZeroHours = moment().set({ hour: 0, minute: 0, second: 0, millisecond: 0 })
  try {
    const numYesterdayOrders = await Order.count({
      where:
      {
        createdAt: {
          [Op.lt]: todayZeroHours,
          [Op.gte]: yesterdayZeroHours
        },
        restaurantId: req.params.restaurantId
      }
    })
    const numPendingOrders = await Order.count({
      where:
      {
        startedAt: null,
        restaurantId: req.params.restaurantId
      }
    })
    const numDeliveredTodayOrders = await Order.count({
      where:
      {
        deliveredAt: { [Op.gte]: todayZeroHours },
        restaurantId: req.params.restaurantId
      }
    })

    const invoicedToday = await Order.sum(
      'price',
      {
        where:
      {
        createdAt: { [Op.gte]: todayZeroHours }, // FIXME: Created or confirmed?
        restaurantId: req.params.restaurantId
      }
      })
    res.json({
      restaurantId: req.params.restaurantId,
      numYesterdayOrders,
      numPendingOrders,
      numDeliveredTodayOrders,
      invoicedToday
    })
  } catch (err) {
    res.status(500).send(err)
  }
}
