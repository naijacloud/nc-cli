/**
 * Field selections shared between operations, so a projection lives in one
 * place instead of drifting between the query that lists a resource and the
 * mutation that creates it.
 */


export const SERVICE_FIELDS = `
  id
  name
  type
  status
  health
  url
  branch
  repoFullName
  isStatic
`;

export const DEPLOYMENT_FIELDS = `
  id
  serviceId
  status
  branch
  commitSha
  commitMessage
  authorName
  buildMethod
  error
  errorCode
  createdAt
  updatedAt
`;

export const DOMAIN_FIELDS = `
  id
  domain
  serviceId
  status
  verifiedAt
  lastCheck
  dnsTarget {
    cname
    aRecord
    isApex
    records { type name value purpose }
    conflicts { type name value purpose }
  }
`;

export const PROJECT_FIELDS = `
  id
  name
  displayName
  description
  teamId
  region
  createdAt
  updatedAt
`;
