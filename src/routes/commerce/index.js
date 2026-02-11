/**
 * Commerce Route Aggregator
 * All commerce routes under /api/v1/commerce
 */

const { Router } = require('express');

const storeRoutes = require('./stores');
const productRoutes = require('./products');
const listingRoutes = require('./listings');
const offerRoutes = require('./offers');
const offerReferenceRoutes = require('./offerReferences');
const orderRoutes = require('./orders');
const lookingForRoutes = require('./lookingFor');
const reviewRoutes = require('./reviews');
const trustRoutes = require('./trust');
const activityRoutes = require('./activity');
const leaderboardRoutes = require('./leaderboard');
const spotlightRoutes = require('./spotlight');

const router = Router();

// Phase 2: Stores, products, listings
router.use('/stores', storeRoutes);
router.use('/products', productRoutes);
router.use('/listings', listingRoutes);

// Phase 3: Offers, orders, looking-for
router.use('/offers', offerRoutes);
router.use('/offer-references', offerReferenceRoutes);
router.use('/orders', orderRoutes);
router.use('/looking-for', lookingForRoutes);

// Phase 4: Reviews, trust
router.use('/reviews', reviewRoutes);
router.use('/trust', trustRoutes);

// Phase 5: Activity, leaderboard, spotlight
router.use('/activity', activityRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/spotlight', spotlightRoutes);

module.exports = router;
