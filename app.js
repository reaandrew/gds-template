const express = require('express');
const nunjucks = require('nunjucks');
const path = require('path');
const fs = require('fs');
const { marked } = require('marked'); // Ensure 'marked' is correctly required
const yaml = require('yaml');
const { MongoClient } = require('mongodb');
 
const app = express();
 
const uri = 'mongodb://localhost:27017'; // MongoDB connection URI
const dbName = 'aws_data'; // Replace with your actual database name
 
const baseBreadcrumbs = [
    { text: 'Home', href: '/' }
];
 
const complianceBreadcrumbs = [
    ...baseBreadcrumbs,
    { text: 'Compliance Reports', href: '/compliance' }
];
 
const policiesBreadcrumbs = [
    ...baseBreadcrumbs,
    { text: 'Policies', href: '/policies' }
];
 
// Configuration for Markdown directory
const markdownRoot = path.join(__dirname, 'markdown'); // Adjust the path as necessary
 
const mandatoryTags = ["PRCode", "Source", "SN_ServiceID", "SN_Environment", "SN_Application"];
 
// Load and parse the YAML file
 
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
 
 
// Route for the homepage
app.get('/', (req, res) => {
    res.redirect('/compliance');
});
 
app.get('/compliance', (req, res) => {
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
        navigationSections: navigationSections
    });
});
 
// Route for /policies to render first policy
app.get('/policies', (req, res) => {
    res.redirect('/policies/tagging');
});
 
// Markdown rendering route for policies
app.get('/policies/:policy', (req, res) => {
    const policy = req.params.policy;
    const filePath = path.join(markdownRoot, `${policy}.md`);
 
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            return res.status(404).send('File not found');
        }
 
        const htmlContent = marked(data); // Parse markdown to HTML
        const navigationSections = [
            {
                title: "Policies",
                items: [
                    { text: "Tagging", href: "/policies/tagging" },
                    { text: "Load Balancers", href: "/policies/loadbalancers" },
                    { text: "Database", href: "/policies/database" },
                    { text: "Decommissioning", href: "/policies/decommissioning" },
                    { text: "Containers", href: "/policies/containers" },
                    { text: "Monitoring and Alerting", href: "/policies/monitoring" },
                    { text: "AMIs", href: "/policies/amis" },
                    { text: "Agents and Ports", href: "/policies/agents" }
                ]
            }
        ];
 
        res.render('policy.njk', {
            breadcrumbs: [...policiesBreadcrumbs, { text: policy, href: `/policies/${policy}` }],
            policyContent: htmlContent,
            navigationSections: navigationSections
        });
    });
});
 
// Additional routes for the example provided
 
// Main policy route for tagging, redirects to teams
app.get('/compliance/tagging', (req, res) => {
    res.redirect('/compliance/tagging/teams');
});
 
app.get('/compliance/tagging/teams', async (req, res) => {
    const client = new MongoClient(uri);
 
    try {
        await client.connect();
        const col = client.db(dbName).collection("tags");
 
        const cursor = col
            .find({}, { projection: { day: 1, account_id: 1, resource_id: 1, resource_type: 1, tags: 1 } })
            .sort({ day: -1 });
 
        const mandLower = mandatoryTags.map(t => t.toLowerCase());
        const teamAgg = new Map();            // team → { resourcesCount, _seen:Set }
        const ensureTeam = t => {
            if (!teamAgg.has(t))
                teamAgg.set(t, { resourcesCount: 0, _seen: new Set() });
            return teamAgg.get(t);
        };
 
        const isMissing = v =>
            v === null || v === undefined || (typeof v === "string" && v.trim() === "");
 
        const bucketStartsWithAccountId = arn => /^\d{12}/.test((arn.split(":::")[1] || ""));
 
        for await (const doc of cursor) {
            if (doc.resource_type === "bucket" && bucketStartsWithAccountId(doc.resource_id)) continue;
 
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
 
            // global dedupe – if we’ve seen this resource already, skip it
            if (rec._seen.has(doc.resource_id)) continue;
            rec._seen.add(doc.resource_id);
 
            const tags = Object.fromEntries(
                Object.entries(doc.tags || {}).map(([k, v]) => [k.toLowerCase(), v])
            );
            const hasMissing = mandLower.some(k => isMissing(tags[k]));
            if (hasMissing) rec.resourcesCount += 1;
        }
 
        const data = [...teamAgg.entries()]
            .filter(([, v]) => v.resourcesCount > 0)
            .map(([team, v]) => ({ team, resourcesCount: v.resourcesCount }))
            .sort((a, b) => b.resourcesCount - a.resourcesCount);
 
        res.render('policies/tagging/teams.njk', {
            breadcrumbs: [...complianceBreadcrumbs, { text: "Tagging", href: "/compliance/tagging" }],
            policy_title: "Tagging (by Team)",
            menu_items: [
                { href: "/compliance/tagging/teams", text: "Teams Overview" },
                { href: "/compliance/tagging/services", text: "Services Overview" }
            ],
            data
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Internal Server Error");
    } finally {
        await client.close();
    }
});
 
app.get('/compliance/tagging/services', (req, res) => {
    res.render('policies/tagging/services.njk', {
        breadcrumbs: [...complianceBreadcrumbs, { text: "Tagging", href: "/compliance/tagging" }],
        policy_title: "Tagging",
        menu_items: [
            { href: "/compliance/tagging/teams", text: "Teams Overview" },
            { href: "/compliance/tagging/services", text: "Services Overview" }
        ]
    });
});
 
app.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});
