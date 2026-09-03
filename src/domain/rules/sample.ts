/** Scaffolded by `detour rules init`. Kept as a plain string so the emitted file's formatting is exact. */
export const SAMPLE_RULES_FILE = `{
  "rules": [
    {
      "name": "mock-example-users",
      "enabled": true,
      "match": {
        "method": "GET",
        "url": "https://api.example.com/users/*"
      },
      "action": {
        "type": "mock",
        "status": 200,
        "body": {
          "id": 1,
          "name": "Detour Mock User"
        }
      }
    },
    {
      "name": "route-example-to-staging",
      "enabled": false,
      "match": {
        "url": "https://api.example.com/*"
      },
      "action": {
        "type": "route",
        "host": "staging.example.com"
      }
    },
    {
      "name": "rewrite-example-add-header",
      "enabled": false,
      "match": {
        "url": "https://api.example.com/*"
      },
      "action": {
        "type": "rewrite",
        "request": {
          "headers": {
            "set": { "X-Detour": "1" }
          }
        }
      }
    },
    {
      "name": "rewrite-example-query",
      "enabled": false,
      "match": {
        "url": "https://api.example.com/*"
      },
      "action": {
        "type": "rewrite",
        "request": {
          "query": {
            "set": { "debug": "1" },
            "remove": ["token"]
          }
        }
      }
    },
    {
      "name": "breakpoint-example",
      "enabled": false,
      "match": {
        "url": "https://api.example.com/*"
      },
      "action": {
        "type": "breakpoint"
      }
    },
    {
      "name": "script-example",
      "enabled": false,
      "match": {
        "url": "https://api.example.com/*"
      },
      "action": {
        "type": "script",
        "path": "./example.script.js"
      }
    }
  ]
}
`;
