# Security

Loopback only. Single operator with signed HttpOnly/SameSite cookie, expiring/revocable server session, CSRF/Origin checks and Redis login rate limit. OpenAI keys belong only to the worker environment. Never log credentials, raw provider errors or chain-of-thought. Every child resource must match its project/task parents.
