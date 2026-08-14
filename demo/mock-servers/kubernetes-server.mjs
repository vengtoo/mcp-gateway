#!/usr/bin/env node

/**
 * Mock Kubernetes MCP Server — simulates kubectl-style operations for demo purposes.
 * Implements MCP protocol over stdio with realistic K8s management tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  {
    name: "get_pods",
    description: "List pods in a namespace",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Kubernetes namespace", default: "default" },
      },
    },
  },
  {
    name: "get_deployments",
    description: "List deployments in a namespace",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Kubernetes namespace", default: "default" },
      },
    },
  },
  {
    name: "get_services",
    description: "List services in a namespace",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Kubernetes namespace", default: "default" },
      },
    },
  },
  {
    name: "describe_pod",
    description: "Get detailed information about a specific pod",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Pod name" },
        namespace: { type: "string", description: "Kubernetes namespace", default: "default" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_logs",
    description: "Get logs from a pod",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Pod name" },
        namespace: { type: "string", description: "Kubernetes namespace", default: "default" },
        tail: { type: "number", description: "Number of lines", default: 50 },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_resource",
    description: "Delete a Kubernetes resource (pod, deployment, service, namespace, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Resource kind (pod, deployment, service, namespace, etc.)" },
        name: { type: "string", description: "Resource name" },
        namespace: { type: "string", description: "Kubernetes namespace" },
      },
      required: ["kind", "name"],
    },
  },
  {
    name: "scale_deployment",
    description: "Scale a deployment to a specified number of replicas",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Deployment name" },
        namespace: { type: "string", description: "Kubernetes namespace", default: "default" },
        replicas: { type: "number", description: "Desired replica count" },
      },
      required: ["name", "replicas"],
    },
  },
  {
    name: "apply_manifest",
    description: "Apply a Kubernetes manifest (YAML)",
    inputSchema: {
      type: "object",
      properties: {
        yaml: { type: "string", description: "YAML manifest content" },
        namespace: { type: "string", description: "Kubernetes namespace", default: "default" },
      },
      required: ["yaml"],
    },
  },
];

const MOCK_PODS = {
  production: [
    { name: "api-server-7d8f9c-x2k4n", status: "Running", restarts: 0, age: "15d", node: "ip-10-0-1-42" },
    { name: "api-server-7d8f9c-m9j3p", status: "Running", restarts: 0, age: "15d", node: "ip-10-0-1-43" },
    { name: "api-server-7d8f9c-q8h2r", status: "Running", restarts: 1, age: "15d", node: "ip-10-0-2-11" },
    { name: "worker-5c6d7e-a1b2c", status: "Running", restarts: 0, age: "8d", node: "ip-10-0-2-12" },
    { name: "worker-5c6d7e-d3e4f", status: "Running", restarts: 0, age: "8d", node: "ip-10-0-1-42" },
    { name: "redis-primary-0", status: "Running", restarts: 0, age: "30d", node: "ip-10-0-1-43" },
    { name: "redis-replica-0", status: "Running", restarts: 0, age: "30d", node: "ip-10-0-2-11" },
    { name: "ingress-nginx-controller-8f7g6h-k5l2", status: "Running", restarts: 0, age: "45d", node: "ip-10-0-1-42" },
  ],
  staging: [
    { name: "api-server-staging-abc123", status: "Running", restarts: 2, age: "3d", node: "ip-10-0-3-20" },
    { name: "worker-staging-def456", status: "Running", restarts: 0, age: "3d", node: "ip-10-0-3-21" },
  ],
};

const MOCK_DEPLOYMENTS = {
  production: [
    { name: "api-server", replicas: "3/3", image: "acme/api:v2.14.3", age: "15d" },
    { name: "worker", replicas: "2/2", image: "acme/worker:v2.14.3", age: "8d" },
    { name: "ingress-nginx-controller", replicas: "1/1", image: "k8s.gcr.io/ingress-nginx:v1.9.4", age: "45d" },
  ],
  staging: [
    { name: "api-server-staging", replicas: "1/1", image: "acme/api:v2.15.0-rc1", age: "3d" },
    { name: "worker-staging", replicas: "1/1", image: "acme/worker:v2.15.0-rc1", age: "3d" },
  ],
};

const MOCK_SERVICES = {
  production: [
    { name: "api-server", type: "ClusterIP", clusterIP: "10.96.45.12", ports: "8080/TCP" },
    { name: "redis-primary", type: "ClusterIP", clusterIP: "10.96.78.34", ports: "6379/TCP" },
    { name: "ingress-nginx", type: "LoadBalancer", externalIP: "52.14.231.87", ports: "80/TCP,443/TCP" },
  ],
};

function handleTool(name, args) {
  const ns = args.namespace || "default";

  switch (name) {
    case "get_pods": {
      const pods = MOCK_PODS[ns] || [];
      return formatResult({ namespace: ns, pods, count: pods.length });
    }

    case "get_deployments": {
      const deps = MOCK_DEPLOYMENTS[ns] || [];
      return formatResult({ namespace: ns, deployments: deps, count: deps.length });
    }

    case "get_services": {
      const svcs = MOCK_SERVICES[ns] || [];
      return formatResult({ namespace: ns, services: svcs, count: svcs.length });
    }

    case "describe_pod": {
      const pods = MOCK_PODS[ns] || [];
      const pod = pods.find((p) => p.name === args.name);
      if (!pod) return errorResult(`Pod '${args.name}' not found in namespace '${ns}'`);
      return formatResult({
        ...pod,
        namespace: ns,
        labels: { app: pod.name.replace(/-[a-z0-9]+-[a-z0-9]+$/, "") },
        containers: [{ name: "main", image: "acme/api:v2.14.3", state: "running", ready: true }],
      });
    }

    case "get_logs": {
      return formatResult({
        pod: args.name,
        namespace: ns,
        lines: [
          "2025-04-28T10:00:01Z INFO  server started on :8080",
          "2025-04-28T10:00:02Z INFO  connected to redis at redis-primary:6379",
          "2025-04-28T10:05:15Z INFO  health check passed",
          "2025-04-28T10:10:30Z INFO  processed 1,247 requests in last 5m",
          "2025-04-28T10:15:45Z INFO  health check passed",
        ],
      });
    }

    case "delete_resource": {
      const kind = args.kind.toLowerCase();
      const target = args.name;

      if (kind === "namespace" && target === "production") {
        return formatResult({
          status: "deleted",
          warning: "CRITICAL: Namespace 'production' and ALL its resources have been deleted. This is irreversible.",
          resourcesDeleted: ["3 deployments", "8 pods", "3 services", "2 statefulsets", "5 configmaps", "3 secrets"],
        });
      }

      if (kind === "deployment") {
        return formatResult({
          status: "deleted",
          resource: `deployment/${target}`,
          namespace: ns,
          warning: `Deployment '${target}' deleted. All associated pods are terminating.`,
        });
      }

      return formatResult({
        status: "deleted",
        resource: `${kind}/${target}`,
        namespace: ns,
      });
    }

    case "scale_deployment": {
      return formatResult({
        deployment: args.name,
        namespace: ns,
        previousReplicas: 3,
        newReplicas: args.replicas,
        status: args.replicas === 0 ? "scaled to zero — all pods terminating" : "scaling",
      });
    }

    case "apply_manifest": {
      return formatResult({
        status: "applied",
        namespace: ns,
        resources: ["resource configured"],
      });
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function formatResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

const server = new Server(
  { name: "mock-kubernetes-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return handleTool(request.params.name, request.params.arguments ?? {});
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mock-kubernetes] ready — 8 tools registered");
