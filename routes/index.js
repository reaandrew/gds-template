const express = require('express');
const router = express.Router();

// Route for the homepage
router.get('/', (req, res) => {
    res.redirect('/compliance');
});

module.exports = router;