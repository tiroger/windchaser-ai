# Adopting infrastructure created outside Terraform.
#
# Import blocks rather than a local `terraform import`, so the adoption runs in
# CI under the deployment role, is reviewable in the diff, and needs nobody's
# laptop credentials. Remove an entry once its apply has succeeded.

# Amplify created and attached this Web ACL when the repository was connected.
# It was blocking Strava's webhook validation on NoUserAgent_HEADER and the
# briefing payload on SizeRestrictions_BODY, with no declaration anywhere
# explaining why either failed.
import {
  to = module.web_firewall.aws_wafv2_web_acl.amplify
  id = "8b5c2cb1-4584-4ed1-a38e-d7f24f3c7080/CreatedByAmplify-d3f0frh0dwcdg7-f2d8f3a8-5639-4758-b8e8-3bfa6775d748/CLOUDFRONT"
}
