-- Local development only. In Azure the group roles are created by migration 0001
-- and login principals are managed identities added with pgaadauth_create_principal.
CREATE ROLE em_app NOLOGIN;
CREATE ROLE em_definer NOLOGIN;
CREATE ROLE app_user LOGIN PASSWORD 'app_user' IN ROLE em_app;
