param name string
param tags object
param apiHost string
param publicApiHost string
param adminHost string

// One endpoint, routed per surface (ADR 0007, 0009):
//   /v1/*         → core API, never cached
//   /public/v1/*  → public API, cached; the cache key includes the full query string,
//                   which carries the publishable key. Front Door does not vary on headers,
//                   so tenant identity must never travel only in a header on this route.
//   /*            → admin SPA from blob static website
resource profile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: 'afd-${name}'
  location: 'global'
  tags: tags
  sku: { name: 'Standard_AzureFrontDoor' }
}

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: profile
  name: 'ep-${name}'
  location: 'global'
  properties: { enabledState: 'Enabled' }
}

var originDefs = [
  { key: 'api', host: apiHost, probe: '/healthz' }
  { key: 'public', host: publicApiHost, probe: '/healthz' }
  { key: 'admin', host: adminHost, probe: '/index.html' }
]

resource groups 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = [for o in originDefs: {
  parent: profile
  name: 'og-${o.key}'
  properties: {
    loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3, additionalLatencyInMilliseconds: 50 }
    healthProbeSettings: { probePath: o.probe, probeRequestType: 'GET', probeProtocol: 'Https', probeIntervalInSeconds: 60 }
  }
}]

resource origins 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = [for (o, i) in originDefs: {
  parent: groups[i]
  name: 'o-${o.key}'
  properties: { hostName: o.host, originHostHeader: o.host, httpsPort: 443, priority: 1, weight: 1000, enforceCertificateNameCheck: true }
}]

// SPA fallback: paths without a file extension are served index.html.
resource spaRules 'Microsoft.Cdn/profiles/ruleSets@2024-02-01' = {
  parent: profile
  name: 'spa'
}

resource spaFallback 'Microsoft.Cdn/profiles/ruleSets/rules@2024-02-01' = {
  parent: spaRules
  name: 'indexFallback'
  properties: {
    order: 1
    conditions: [{ name: 'UrlFileExtension', parameters: { typeName: 'DeliveryRuleUrlFileExtensionMatchConditionParameters', operator: 'GreaterThan', matchValues: ['0'], negateCondition: true } }]
    actions: [{ name: 'UrlRewrite', parameters: { typeName: 'DeliveryRuleUrlRewriteActionParameters', sourcePattern: '/', destination: '/index.html', preserveUnmatchedPath: false } }]
  }
}

resource apiRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: endpoint
  name: 'r-api'
  properties: {
    originGroup: { id: groups[0].id }
    patternsToMatch: ['/v1/*']
    supportedProtocols: ['Https']
    httpsRedirect: 'Enabled'
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
  }
  dependsOn: [origins]
}

resource publicRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: endpoint
  name: 'r-public'
  properties: {
    originGroup: { id: groups[1].id }
    patternsToMatch: ['/public/v1/*']
    supportedProtocols: ['Https']
    httpsRedirect: 'Enabled'
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    cacheConfiguration: {
      queryStringCachingBehavior: 'UseQueryString'
      compressionSettings: { isCompressionEnabled: true, contentTypesToCompress: ['application/json', 'text/calendar'] }
    }
  }
  dependsOn: [origins, apiRoute]
}

resource adminRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: endpoint
  name: 'r-admin'
  properties: {
    originGroup: { id: groups[2].id }
    patternsToMatch: ['/*']
    supportedProtocols: ['Https']
    httpsRedirect: 'Enabled'
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    ruleSets: [{ id: spaRules.id }]
    cacheConfiguration: { queryStringCachingBehavior: 'IgnoreQueryString', compressionSettings: { isCompressionEnabled: true, contentTypesToCompress: ['text/html', 'application/javascript', 'text/css'] } }
  }
  dependsOn: [origins, publicRoute, spaFallback]
}

resource waf 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = {
  name: replace('waf${name}', '-', '')
  location: 'global'
  tags: tags
  sku: { name: 'Standard_AzureFrontDoor' }
  properties: {
    policySettings: { enabledState: 'Enabled', mode: 'Prevention' }
    customRules: {
      rules: [
        {
          name: 'PublicApiRateLimit'
          priority: 10
          ruleType: 'RateLimitRule'
          rateLimitDurationInMinutes: 1
          rateLimitThreshold: 600
          action: 'Block'
          matchConditions: [{ matchVariable: 'RequestUri', operator: 'Contains', matchValue: ['/public/v1/'] }]
        }
      ]
    }
  }
}

resource security 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: profile
  name: 'sp-${name}'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: waf.id }
      associations: [{ domains: [{ id: endpoint.id }], patternsToMatch: ['/*'] }]
    }
  }
}

output endpointHost string = endpoint.properties.hostName
