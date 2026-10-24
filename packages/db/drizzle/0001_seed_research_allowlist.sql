-- Allowlist seeds for the research sources. Apex and www forms are both listed because
-- the url-fetcher follows one allowlisted redirect hop. Admins can remove rows with
-- /squirrel-admin remove; ON CONFLICT keeps any row an admin already edited.
INSERT INTO "url_config" ("url", "description", "enabled", "added_by") VALUES
  ('https://www.firstinspires.org/*', 'FIRST official site: FRC, FTC and FLL programs, events, season materials, team resources, game rules', true, 'seed'),
  ('https://firstinspires.org/*', 'redirect alias of www.firstinspires.org', true, 'seed'),
  ('https://community.firstinspires.org/*', 'FIRST community blog: announcements, season news, updates', true, 'seed'),
  ('https://frc-events.firstinspires.org/*', 'FRC events: event schedules, rankings, match results, awards', true, 'seed'),
  ('https://ftc-events.firstinspires.org/*', 'FTC events: event schedules, rankings, match results, awards', true, 'seed'),
  ('https://frc-api-docs.firstinspires.org/*', 'FRC Events API documentation', true, 'seed'),
  ('https://ftc-docs.firstinspires.org/*', 'FTC documentation: programming, control system, game manual guides', true, 'seed'),
  ('https://docs.wpilib.org/*', 'WPILib documentation: FRC robot programming, control system, swerve, vision, command framework', true, 'seed'),
  ('https://frc-docs.readthedocs.io/*', 'redirect alias of docs.wpilib.org', true, 'seed'),
  ('https://firstfrc.blob.core.windows.net/frc2026/Manual/2026GameManual.pdf', 'FRC 2026 game manual PDF: game rules, robot rules, tournament rules', true, 'seed'),
  ('https://www.chiefdelphi.com/*', 'Chief Delphi FRC community forum', true, 'seed'),
  ('https://chiefdelphi.com/*', 'redirect alias of www.chiefdelphi.com', true, 'seed'),
  ('https://www.thebluealliance.com/*', 'The Blue Alliance: FRC team and event results', true, 'seed'),
  ('https://thebluealliance.com/*', 'redirect alias of www.thebluealliance.com', true, 'seed'),
  ('https://www.statbotics.io/*', 'Statbotics: FRC EPA team and event statistics', true, 'seed'),
  ('https://statbotics.io/*', 'redirect alias of www.statbotics.io', true, 'seed'),
  ('https://api.statbotics.io/*', 'Statbotics REST API', true, 'seed'),
  ('https://programs.innovationtreehouse.org/*', 'Innovation Treehouse programs wiki: programs, schedules, policies, handbook', true, 'seed')
ON CONFLICT ("url") DO NOTHING;
