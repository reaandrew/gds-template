const express = require('express');
const nunjucks = require('nunjucks');
const path = require('path');

const app = express();

// Configure Nunjucks
nunjucks.configure([
    path.join(__dirname, 'node_modules/govuk-frontend/dist'),
    path.join(__dirname, 'views')
], {
    autoescape: true,
    express: app,
});

// Serve GOV.UK Frontend assets
app.use('/assets', express.static(
    path.join(__dirname, 'node_modules/govuk-frontend/dist/govuk/assets')
));

// Serve custom stylesheets from the 'stylesheets' directory
app.use('/stylesheets', express.static(
    path.join(__dirname, 'node_modules/govuk-frontend/dist/govuk')
));

app.use('/javascripts', express.static(
    path.join(__dirname, 'node_modules/govuk-frontend/dist/govuk')
));

// Import and use route modules
const indexRoutes = require('./routes/index');
const complianceRoutes = require('./routes/compliance');
const policiesRoutes = require('./routes/policies');
const taggingRoutes = require('./routes/compliance/tagging');
const databaseRoutes = require('./routes/compliance/database');
const loadbalancersRoutes = require('./routes/compliance/loadbalancers');
const autoscalingRoutes = require('./routes/compliance/autoscaling');
const kmsRoutes = require('./routes/compliance/kms');

// Use the routes
app.use('/', indexRoutes);
app.use('/compliance', complianceRoutes);
app.use('/policies', policiesRoutes);
app.use('/compliance/tagging', taggingRoutes);
app.use('/compliance/database', databaseRoutes);
app.use('/compliance/loadbalancers', loadbalancersRoutes);
app.use('/compliance/autoscaling', autoscalingRoutes);
app.use('/compliance/kms', kmsRoutes);

app.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});