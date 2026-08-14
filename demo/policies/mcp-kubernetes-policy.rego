package vengtoo.mcp

# MCP Kubernetes Policy — prevents destructive operations on production
#
# This policy allows read operations (get_pods, get_deployments, get_services,
# describe_pod, get_logs) but blocks destructive operations (delete_resource,
# scale to zero) on the production namespace. Staging is unrestricted.

default allow := false

# Read-only tools are always allowed
allow if {
    input.resource.name == "kubernetes__get_pods"
}

allow if {
    input.resource.name == "kubernetes__get_deployments"
}

allow if {
    input.resource.name == "kubernetes__get_services"
}

allow if {
    input.resource.name == "kubernetes__describe_pod"
}

allow if {
    input.resource.name == "kubernetes__get_logs"
}

# Apply manifests allowed in non-production namespaces
allow if {
    input.resource.name == "kubernetes__apply_manifest"
    input.resource.attributes.namespace != "production"
}

# Scale deployments allowed in non-production namespaces
allow if {
    input.resource.name == "kubernetes__scale_deployment"
    input.resource.attributes.namespace != "production"
}

# Scale in production allowed only if replicas > 0
allow if {
    input.resource.name == "kubernetes__scale_deployment"
    input.resource.attributes.namespace == "production"
    input.resource.attributes.replicas > 0
}

# Delete allowed in non-production namespaces
allow if {
    input.resource.name == "kubernetes__delete_resource"
    ns := object.get(input.resource.attributes, "namespace", "default")
    ns != "production"
    input.resource.attributes.kind != "namespace"
}

# Delete namespace is never allowed for AI agents
# (deleting a namespace wipes everything in it)

# Deny reasons
reason := "BLOCKED: Deleting resources in the production namespace is not permitted for AI agents. Production changes require human approval through the deployment pipeline." if {
    input.resource.name == "kubernetes__delete_resource"
    ns := object.get(input.resource.attributes, "namespace", "default")
    ns == "production"
}

reason := "BLOCKED: Deleting Kubernetes namespaces is not permitted for AI agents. This would destroy all resources within the namespace." if {
    input.resource.name == "kubernetes__delete_resource"
    input.resource.attributes.kind == "namespace"
}

reason := "BLOCKED: Scaling production deployments to zero is not permitted for AI agents. This would cause a service outage." if {
    input.resource.name == "kubernetes__scale_deployment"
    input.resource.attributes.namespace == "production"
    input.resource.attributes.replicas == 0
}
