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
 
const mandatoryTags = ["PRCode", "Source", "SN_ServiceID", "SN_Environment", "SN_Application", "Project", "Service", "BillingID"];
 
const mappings = yaml.parse(fs.readFileSync(path.join(__dirname, 'config/account_mappings.yaml'), 'utf8'));
const accountIdToTeam = Object.fromEntries(mappings.map(mapping => [mapping.OwnerId, mapping.Team]));
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
            .find({}, { projection: { day: 1, account_id: 1, resource_id: 1, resource_type: 1, Tags: 1 } })
            .sort({ day: -1 });
 
        const mandLower = mandatoryTags.map(t => t.toLowerCase());
        const teamAgg = new Map();            // team → { resourceTypes: Map<resourceType, tagMissing: Map<tagName, count>>, _seen: Set }
        const ensureTeam = t => {
            if (!teamAgg.has(t)) {
                teamAgg.set(t, { resourceTypes: new Map(), _seen: new Set() });
            }
            return teamAgg.get(t);
        };
        
        const ensureResourceType = (teamRec, resourceType) => {
            if (!teamRec.resourceTypes.has(resourceType)) {
                const tagMissing = new Map();
                mandatoryTags.forEach(tag => tagMissing.set(tag, 0));
                teamRec.resourceTypes.set(resourceType, tagMissing);
            }
            return teamRec.resourceTypes.get(resourceType);
        };
 
        const isMissing = v =>
            v === null || v === undefined || (typeof v === "string" && v.trim() === "");
 
        const bucketStartsWithAccountId = arn => /^\d{12}/.test((arn.split(":::")[1] || ""));
 
        for await (const doc of cursor) {
            if (doc.resource_type === "bucket" && bucketStartsWithAccountId(doc.resource_id)) continue;
 
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
 
            // global dedupe – if we’ve seen this resource already, skip it
            if (teamRec._seen.has(doc.resource_id)) continue;
            teamRec._seen.add(doc.resource_id);

            const resourceType = doc.resource_type || "unknown";
            const tagMissing = ensureResourceType(teamRec, resourceType);
 
            // Convert Tags array to object for easier lookup
            const tags = {};
            if (doc.Tags && Array.isArray(doc.Tags)) {
                doc.Tags.forEach(tag => {
                    if (tag.Key && tag.Value !== undefined) {
                        tags[tag.Key.toLowerCase()] = tag.Value;
                    }
                });
            }
            
            // Check each mandatory tag and increment missing count
            mandLower.forEach((tagLower, index) => {
                if (isMissing(tags[tagLower])) {
                    const originalTagName = mandatoryTags[index];
                    tagMissing.set(originalTagName, tagMissing.get(originalTagName) + 1);
                }
            });
        }
 
        // Format data for view
        const data = [...teamAgg.entries()]
            .map(([team, teamRec]) => ({
                team,
                resourceTypes: [...teamRec.resourceTypes.entries()].map(([resourceType, tagMissing]) => ({
                    resourceType,
                    tags: mandatoryTags.map(tag => ({
                        tagName: tag,
                        missingCount: tagMissing.get(tag),
                        hasMissing: tagMissing.get(tag) > 0
                    }))
                }))
            }))
            .filter(teamData => teamData.resourceTypes.some(rt => rt.tags.some(tag => tag.hasMissing)))
            .sort((a, b) => {
                const totalA = a.resourceTypes.reduce((sum, rt) => sum + rt.tags.reduce((tagSum, tag) => tagSum + tag.missingCount, 0), 0);
                const totalB = b.resourceTypes.reduce((sum, rt) => sum + rt.tags.reduce((tagSum, tag) => tagSum + tag.missingCount, 0), 0);
                return totalB - totalA;
            });
 
        res.render('policies/tagging/teams.njk', {
            breadcrumbs: [...complianceBreadcrumbs, { text: "Tagging", href: "/compliance/tagging" }],
            policy_title: "Tagging Compliance by Team",
            menu_items: [
                { href: "/compliance/tagging/teams", text: "Teams Overview" },
                { href: "/compliance/tagging/services", text: "Services Overview" }
            ],
            data,
            mandatoryTags
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
 
// Load Balancer TLS Configurations
app.get('/compliance/loadbalancers', (req, res) => {
    res.redirect('/compliance/loadbalancers/tls');
});
app.get('/compliance/loadbalancers/tls', async (req, res) => {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db(dbName);
        
        // Query all load balancer collections
        const elbV2Col = db.collection("elb_v2");
        const elbV2ListenersCol = db.collection("elb_v2_listeners");
        const elbClassicCol = db.collection("elb_classic");
        
        const teamTls = new Map(); // team → { tlsVersions: Map<version, count>, totalLBs: count }
        
        const ensureTeam = t => {
            if (!teamTls.has(t))
                teamTls.set(t, { tlsVersions: new Map(), totalLBs: 0 });
            return teamTls.get(t);
        };
        
        // First, count ALL load balancers by team
        const elbV2Cursor = elbV2Col.find({}, { projection: { account_id: 1 } });
        for await (const doc of elbV2Cursor) {
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            rec.totalLBs++;
        }
        
        const elbClassicTotalCursor = elbClassicCol.find({}, { projection: { account_id: 1 } });
        for await (const doc of elbClassicTotalCursor) {
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            rec.totalLBs++;
        }
        
        // Then, count load balancers WITH TLS certificates
        const elbV2ListenersCursor = elbV2ListenersCol.find({}, { projection: { account_id: 1, Configuration: 1 } });
        
        for await (const doc of elbV2ListenersCursor) {
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            
            if (doc.Configuration) {
                const protocol = doc.Configuration.Protocol;
                if (protocol === "HTTPS" || protocol === "TLS") {
                    const policy = doc.Configuration.SslPolicy || "Unknown";
                    rec.tlsVersions.set(policy, (rec.tlsVersions.get(policy) || 0) + 1);
                }
            }
        }
        
        // Process Classic ELB listeners
        const elbClassicCursor = elbClassicCol.find({}, { projection: { account_id: 1, Configuration: 1 } });
        
        for await (const doc of elbClassicCursor) {
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            
            if (doc.Configuration?.ListenerDescriptions) {
                for (const listenerDesc of doc.Configuration.ListenerDescriptions) {
                    const listener = listenerDesc.Listener;
                    if (listener?.Protocol === "HTTPS" || listener?.Protocol === "SSL") {
                        const policy = listenerDesc.PolicyNames?.[0] || "Classic-Default";
                        rec.tlsVersions.set(policy, (rec.tlsVersions.get(policy) || 0) + 1);
                    }
                }
            }
        }
        
        // Helper function to check if TLS policy is deprecated
        const isDeprecatedPolicy = (version) => {
            return version.startsWith('ELBSecurityPolicy-2015') ||
                   version.startsWith('ELBSecurityPolicy-2016') ||
                   version === 'Classic-Default' ||
                   version.includes('TLS-1-0') ||
                   version.includes('TLS-1-1');
        };
        
        // Format data for view
        const data = [...teamTls.entries()].map(([team, rec]) => {
            const totalWithTLS = [...rec.tlsVersions.values()].reduce((sum, count) => sum + count, 0);
            const noCertsCount = rec.totalLBs - totalWithTLS;
            const tlsVersions = [...rec.tlsVersions.entries()].map(([version, count]) => ({ 
                version, 
                count,
                isDeprecated: isDeprecatedPolicy(version),
                isNoCerts: false
            }));
            
            // Add NO CERTS entry if there are load balancers without certificates
            if (noCertsCount > 0) {
                tlsVersions.push({ 
                    version: 'NO CERTS', 
                    count: noCertsCount,
                    isDeprecated: false,
                    isNoCerts: true
                });
            }
            
            return {
                team,
                tlsVersions,
                totalLBs: rec.totalLBs
            };
        }).filter(t => t.totalLBs > 0);
        res.render('policies/loadbalancers/tls.njk', {
            breadcrumbs: [...complianceBreadcrumbs, { text: "Load Balancers", href: "/compliance/loadbalancers" }],
            policy_title: "Load Balancer TLS Configurations",
            menu_items: [
                { href: "/compliance/loadbalancers/tls", text: "TLS Configurations" },
                { href: "/compliance/loadbalancers/types", text: "Load Balancer Types" }
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
// Load Balancer Types Count
app.get('/compliance/loadbalancers/types', async (req, res) => {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db(dbName);
        
        const elbV2Col = db.collection("elb_v2");
        const elbClassicCol = db.collection("elb_classic");
        
        const teamTypes = new Map(); // team → { types: Map<type, count> }
        let totalV2Count = 0;
        let totalClassicCount = 0;
        
        const ensureTeam = t => {
            if (!teamTypes.has(t))
                teamTypes.set(t, { types: new Map() });
            return teamTypes.get(t);
        };
        
        // Count ALB/NLB from elb_v2
        const elbV2Cursor = elbV2Col.find({}, { projection: { account_id: 1, Configuration: 1 } });
        
        for await (const doc of elbV2Cursor) {
            totalV2Count++;
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            const type = doc.Configuration?.Type || "Unknown";
            rec.types.set(type, (rec.types.get(type) || 0) + 1);
        }
        
        // Count Classic ELBs
        const elbClassicCursor = elbClassicCol.find({}, { projection: { account_id: 1 } });
        
        for await (const doc of elbClassicCursor) {
            totalClassicCount++;
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            rec.types.set("classic", (rec.types.get("classic") || 0) + 1);
        }
        
        console.log(`Debug: Total ELB v2: ${totalV2Count}, Total Classic: ${totalClassicCount}`);
        console.log(`Debug: Teams found: ${[...teamTypes.keys()].join(', ')}`);
        
        // Format data
        const data = [...teamTypes.entries()].map(([team, rec]) => ({
            team,
            types: [...rec.types.entries()].map(([type, count]) => ({ 
                type: type === "application" ? "ALB" : type === "network" ? "NLB" : type === "classic" ? "Classic" : type,
                count 
            }))
        })).filter(t => t.types.length > 0);
        res.render('policies/loadbalancers/types.njk', {
            breadcrumbs: [...complianceBreadcrumbs, { text: "Load Balancers", href: "/compliance/loadbalancers" }],
            policy_title: "Load Balancer Types by Team",
            menu_items: [
                { href: "/compliance/loadbalancers/tls", text: "TLS Configurations" },
                { href: "/compliance/loadbalancers/types", text: "Load Balancer Types" }
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
// Database Engines and Versions
app.get('/compliance/database', async (req, res) => {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db(dbName);
        
        const rdsCol = db.collection("rds");
        const redshiftCol = db.collection("redshift_clusters");
        
        const teamDatabases = new Map(); // team → { engines: Map<engine-version, count> }
        
        const ensureTeam = t => {
            if (!teamDatabases.has(t))
                teamDatabases.set(t, { engines: new Map() });
            return teamDatabases.get(t);
        };
        
        // Process RDS instances
        const rdsCursor = rdsCol.find({}, { projection: { account_id: 1, Configuration: 1 } });
        
        for await (const doc of rdsCursor) {
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            
            if (doc.Configuration) {
                const engine = doc.Configuration.Engine || "Unknown";
                const version = doc.Configuration.EngineVersion || "Unknown";
                const key = `${engine}-${version}`;
                rec.engines.set(key, (rec.engines.get(key) || 0) + 1);
            }
        }
        
        // Process Redshift clusters
        const redshiftCursor = redshiftCol.find({}, { projection: { account_id: 1, Configuration: 1 } });
        
        for await (const doc of redshiftCursor) {
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            
            if (doc.Configuration) {
                const version = doc.Configuration.ClusterVersion || "Unknown";
                const key = `redshift-${version}`;
                rec.engines.set(key, (rec.engines.get(key) || 0) + 1);
            }
        }
        
        // Format data
        const data = [...teamDatabases.entries()].map(([team, rec]) => ({
            team,
            engines: [...rec.engines.entries()].map(([engineVersion, count]) => {
                const [engine, ...versionParts] = engineVersion.split("-");
                return { engine, version: versionParts.join("-"), count };
            })
        })).filter(t => t.engines.length > 0);
        res.render('policies/database/engines.njk', {
            breadcrumbs: [...complianceBreadcrumbs, { text: "Database", href: "/compliance/database" }],
            policy_title: "Database Engines and Versions",
            data
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Internal Server Error");
    } finally {
        await client.close();
    }
});
// KMS Key Ages
app.get('/compliance/kms', async (req, res) => {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const kmsCol = db.collection("kms_key_metadata");
        
        const teamKeyAges = new Map(); // team → { ageBuckets: Map<bucket, count> }
        
        const ensureTeam = t => {
            if (!teamKeyAges.has(t))
                teamKeyAges.set(t, { ageBuckets: new Map() });
            return teamKeyAges.get(t);
        };
        
        // Define age buckets
        const getAgeBucket = (creationDate) => {
            if (!creationDate) return "Unknown";
            const ageInDays = (Date.now() - new Date(creationDate).getTime()) / (1000 * 60 * 60 * 24);
            if (ageInDays < 30) return "0-30 days";
            if (ageInDays < 90) return "30-90 days";
            if (ageInDays < 180) return "90-180 days";
            if (ageInDays < 365) return "180-365 days";
            if (ageInDays < 730) return "1-2 years";
            return "2+ years";
        };
        
        const kmsCursor = kmsCol.find({}, { projection: { account_id: 1, Configuration: 1 } });
        
        for await (const doc of kmsCursor) {
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            
            if (doc.Configuration?.CreationDate) {
                const bucket = getAgeBucket(doc.Configuration.CreationDate);
                rec.ageBuckets.set(bucket, (rec.ageBuckets.get(bucket) || 0) + 1);
            }
        }
        
        // Format data with ordered buckets
        const bucketOrder = ["0-30 days", "30-90 days", "90-180 days", "180-365 days", "1-2 years", "2+ years", "Unknown"];
        const data = [...teamKeyAges.entries()].map(([team, rec]) => ({
            team,
            ageBuckets: bucketOrder
                .filter(bucket => rec.ageBuckets.has(bucket))
                .map(bucket => ({ bucket, count: rec.ageBuckets.get(bucket) }))
        })).filter(t => t.ageBuckets.length > 0);
        res.render('policies/kms/ages.njk', {
            breadcrumbs: [...complianceBreadcrumbs, { text: "KMS Keys", href: "/compliance/kms" }],
            policy_title: "KMS Key Ages",
            data
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Internal Server Error");
    } finally {
        await client.close();
    }
});
// ASG Overview routes
app.get('/compliance/autoscaling', (req, res) => {
    res.redirect('/compliance/autoscaling/dimensions');
});
// ASG Dimensions (counts by min/max/desired)
app.get('/compliance/autoscaling/dimensions', async (req, res) => {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const asgCol = db.collection("autoscaling_groups");
        
        const teamDimensions = new Map(); // team → { dimensions: Map<dimension-key, count> }
        
        const ensureTeam = t => {
            if (!teamDimensions.has(t))
                teamDimensions.set(t, { dimensions: new Map() });
            return teamDimensions.get(t);
        };
        
        const asgCursor = asgCol.find({}, { projection: { account_id: 1, Configuration: 1 } });
        
        for await (const doc of asgCursor) {
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            const rec = ensureTeam(team);
            
            if (doc.Configuration) {
                const min = doc.Configuration.MinSize || 0;
                const max = doc.Configuration.MaxSize || 0;
                const desired = doc.Configuration.DesiredCapacity || 0;
                const key = `${min}-${max}-${desired}`;
                rec.dimensions.set(key, (rec.dimensions.get(key) || 0) + 1);
            }
        }
        
        // Format data
        const data = [...teamDimensions.entries()].map(([team, rec]) => ({
            team,
            dimensions: [...rec.dimensions.entries()].map(([dimensionKey, count]) => {
                const [min, max, desired] = dimensionKey.split("-");
                return { min: parseInt(min), max: parseInt(max), desired: parseInt(desired), count };
            }).sort((a, b) => b.count - a.count)
        })).filter(t => t.dimensions.length > 0);
        res.render('policies/autoscaling/dimensions.njk', {
            breadcrumbs: [...complianceBreadcrumbs, { text: "Auto Scaling", href: "/compliance/autoscaling" }],
            policy_title: "Auto Scaling Group Dimensions",
            menu_items: [
                { href: "/compliance/autoscaling/dimensions", text: "ASG Dimensions" },
                { href: "/compliance/autoscaling/empty", text: "Empty ASGs" }
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
// ASGs with no instances
app.get('/compliance/autoscaling/empty', async (req, res) => {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const asgCol = db.collection("autoscaling_groups");
        
        const teamCounts = new Map(); // team → count
        
        const asgCursor = asgCol.find(
            { "Configuration.Instances": { $size: 0 } },
            { projection: { account_id: 1 } }
        );
        
        for await (const doc of asgCursor) {
            const team = accountIdToTeam[doc.account_id] || "Unknown";
            teamCounts.set(team, (teamCounts.get(team) || 0) + 1);
        }
        
        const data = [...teamCounts.entries()]
            .map(([team, count]) => ({ team, count }))
            .sort((a, b) => b.count - a.count);
        res.render('policies/autoscaling/empty.njk', {
            breadcrumbs: [...complianceBreadcrumbs, { text: "Auto Scaling", href: "/compliance/autoscaling" }],
            policy_title: "Auto Scaling Groups with No Instances",
            menu_items: [
                { href: "/compliance/autoscaling/dimensions", text: "ASG Dimensions" },
                { href: "/compliance/autoscaling/empty", text: "Empty ASGs" }
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
app.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});
