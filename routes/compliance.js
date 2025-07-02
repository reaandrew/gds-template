const express = require('express');
const { MongoClient } = require('mongodb');
const router = express.Router();

const uri = 'mongodb://localhost:27017';
const dbName = 'aws_data';

// Import shared utilities
const { accountIdToTeam, complianceBreadcrumbs } = require('../utils/shared');

router.get('/', (req, res) => {
    const navigationSections = [
        {
            title: "Compliance Overview",
            items: [
                { text: "By Services", href: "#" },
                { text: "By Teams", href: "#" }
            ]
        },
        {
            title: "Policies",
            items: [
                { text: "Tagging", href: "/compliance/tagging" },
                { text: "Load Balancers", href: "/compliance/loadbalancers" },
                { text: "Database", href: "/compliance/database" },
                { text: "KMS Keys", href: "/compliance/kms" },
                { text: "Auto Scaling", href: "/compliance/autoscaling" },
                { text: "Decommissioning", href: "/compliance/decommissioning" },
                { text: "Containers", href: "/compliance/containers" },
                { text: "Monitoring and Alerting", href: "/compliance/monitoring" },
                { text: "AMIs", href: "/compliance/amis" },
                { text: "Agents and Ports", href: "/compliance/agents" }
            ]
        }
    ];

    res.render('compliance.njk', {
        breadcrumbs: complianceBreadcrumbs,
        navigationSections: navigationSections,
        currentSection: "compliance"
    });
});

module.exports = router;