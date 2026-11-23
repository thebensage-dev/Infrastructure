# Settings that blueprints can't set, applied by the one-shot "authentik-settings" service on
# every deploy. Run with: ak shell -c "exec(open('/setup/settings.py').read())"
import os

from authentik.tenants.models import Tenant

site = os.environ["MAIN_SITE_URL"].rstrip("/")
links = [
    {"name": "Privacy", "href": f"{site}/privacy"},
    {"name": "Terms", "href": f"{site}/terms"},
]

tenant = Tenant.objects.get(schema_name="public")
changed = []
if tenant.footer_links != links:
    tenant.footer_links = links
    changed.append("footer links")
# No "Impersonate" for admins: it only swaps authentik's own session (each app keeps its own), so
# it shows confusing results and isn't needed here.
if tenant.impersonation:
    tenant.impersonation = False
    changed.append("impersonation off")
if changed:
    tenant.save()
print("authentik settings:", ", ".join(changed) or "already up to date")
