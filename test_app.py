import unittest
import datetime
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import database
from database import Base, User, UserSession, Thought, ThoughtLink, WebReference, hash_pin, verify_pin
from main import get_subdomain

class DeepThoughtTestCase(unittest.TestCase):
    def setUp(self):
        # Create an in-memory SQLite database for testing
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(bind=self.engine)
        Session = sessionmaker(bind=self.engine)
        self.db = Session()
        
        # Seed test users
        self.seed_test_users()

    def tearDown(self):
        self.db.close()
        Base.metadata.drop_all(bind=self.engine)

    def seed_test_users(self):
        # Chris (PIN 1234)
        hashed_c, salt_c = hash_pin("1234")
        self.chris = User(
            username="chris",
            pin_hash=hashed_c,
            pin_salt=salt_c
        )
        self.db.add(self.chris)
        
        # Brandon (PIN 5678)
        hashed_b, salt_b = hash_pin("5678")
        self.brandon = User(
            username="brandon",
            pin_hash=hashed_b,
            pin_salt=salt_b
        )
        self.db.add(self.brandon)
        self.db.commit()

    def test_pin_hashing(self):
        # Test valid PIN hashing and verification
        hashed, salt = hash_pin("9999")
        self.assertTrue(verify_pin("9999", salt, hashed))
        self.assertFalse(verify_pin("1111", salt, hashed))

    def test_multi_user_isolation(self):
        # Chris adds a thought
        thought_c = Thought(
            user_id=self.chris.id,
            content="Inventing turtle baseball",
            processed=True
        )
        self.db.add(thought_c)
        
        # Brandon adds a thought
        thought_b = Thought(
            user_id=self.brandon.id,
            content="Creating alligator soccer",
            processed=True
        )
        self.db.add(thought_b)
        self.db.commit()
        
        # Query thoughts specifically for Chris
        thoughts_c = self.db.query(Thought).filter(Thought.user_id == self.chris.id).all()
        self.assertEqual(len(thoughts_c), 1)
        self.assertEqual(thoughts_c[0].content, "Inventing turtle baseball")
        
        # Query thoughts specifically for Brandon
        thoughts_b = self.db.query(Thought).filter(Thought.user_id == self.brandon.id).all()
        self.assertEqual(len(thoughts_b), 1)
        self.assertEqual(thoughts_b[0].content, "Creating alligator soccer")

    def test_login_lockout_logic(self):
        # Test simple failed attempts increment
        user = self.db.query(User).filter(User.username == "chris").first()
        self.assertEqual(user.failed_attempts, 0)
        
        # Simulate failed login
        user.failed_attempts += 1
        self.db.commit()
        self.assertEqual(user.failed_attempts, 1)
        
        # Simulate 3rd failure and lockout
        user.failed_attempts = 3
        user.lockout_until = datetime.datetime.utcnow() + datetime.timedelta(seconds=90)
        self.db.commit()
        
        # Verify lockout is active
        user_db = self.db.query(User).filter(User.username == "chris").first()
        self.assertEqual(user_db.failed_attempts, 3)
        self.assertIsNotNone(user_db.lockout_until)
        self.assertTrue(user_db.lockout_until > datetime.datetime.utcnow())

    def test_subdomain_extraction_mock(self):
        class MockRequest:
            def __init__(self, host):
                self.headers = {"host": host}
                
        # Subdomain chris.teamjames.cc
        req1 = MockRequest("chris.teamjames.cc")
        self.assertEqual(get_subdomain(req1), "chris")
        
        # Subdomain brandon.teamjames.cc
        req2 = MockRequest("brandon.teamjames.cc")
        self.assertEqual(get_subdomain(req2), "brandon")
        
        # Localhost debug bypass
        req3 = MockRequest("localhost:8000")
        self.assertEqual(get_subdomain(req3), "chris")

    def test_ip_subdomain_extraction_bypass(self):
        class MockRequest:
            def __init__(self, host):
                self.headers = {"host": host}
        req = MockRequest("127.0.0.1:8000")
        self.assertEqual(get_subdomain(req), "chris")

    def test_lan_ip_validation(self):
        from main import is_private_ip
        self.assertTrue(is_private_ip("127.0.0.1"))
        self.assertTrue(is_private_ip("10.0.0.1"))
        self.assertTrue(is_private_ip("192.168.1.1"))
        self.assertTrue(is_private_ip("172.16.0.1"))
        self.assertTrue(is_private_ip("::1"))
        
        self.assertFalse(is_private_ip("8.8.8.8"))
        self.assertFalse(is_private_ip("142.250.190.46"))

    def test_theme_and_pin_settings(self):
        user = self.db.query(User).filter(User.username == "chris").first()
        # Check default theme
        self.assertEqual(user.theme, "default")
        
        # Modify theme
        user.theme = "cyberpunk"
        self.db.commit()
        
        user_db = self.db.query(User).filter(User.username == "chris").first()
        self.assertEqual(user_db.theme, "cyberpunk")

    def test_serialization_timezone_aware(self):
        # Chris adds a thought
        thought_c = Thought(
            user_id=self.chris.id,
            content="Validating UTC serialization",
            processed=True
        )
        self.db.add(thought_c)
        self.db.commit()
        
        # Verify thought serialization includes 'Z'
        t_dict = thought_c.to_dict()
        self.assertTrue(t_dict["created_at"].endswith("Z"))
        
        # Verify user serialization includes 'Z' for lockout_until if present
        self.chris.lockout_until = datetime.datetime.utcnow()
        self.db.commit()
        u_dict = self.chris.to_dict()
        self.assertTrue(u_dict["lockout_until"].endswith("Z"))

    def test_thought_edit_and_next_steps(self):
        thought = Thought(
            user_id=self.chris.id,
            content="Original content",
            latitude=40.7128,
            longitude=-74.0060,
            location_name="New York",
            enrichment_summary="Original summary",
            next_steps="Original next steps",
            processed=True
        )
        self.db.add(thought)
        self.db.commit()
        
        # Add a mock web reference
        web_ref = WebReference(
            thought_id=thought.id,
            url="http://example.com",
            title="Example Link"
        )
        self.db.add(web_ref)
        self.db.commit()
        
        # Refresh from DB
        self.db.refresh(thought)
        self.assertEqual(thought.next_steps, "Original next steps")
        self.assertEqual(len(thought.web_references), 1)
        
        # Simulate update logic (same as our PUT endpoint)
        thought.content = "Updated content"
        thought.processed = False
        thought.enrichment_summary = None
        thought.next_steps = None
        self.db.query(WebReference).filter(WebReference.thought_id == thought.id).delete()
        self.db.commit()
        
        # Verify changes
        self.db.refresh(thought)
        self.assertEqual(thought.content, "Updated content")
        self.assertFalse(thought.processed)
        self.assertIsNone(thought.enrichment_summary)
        self.assertIsNone(thought.next_steps)
        self.assertEqual(len(thought.web_references), 0)
        # Verify location was preserved
        self.assertEqual(thought.latitude, 40.7128)
        self.assertEqual(thought.longitude, -74.0060)
        self.assertEqual(thought.location_name, "New York")

    def test_enrichment_concurrency_guard(self):
        from main import processing_thoughts, enrich_thought_task
        # Add a mock thought ID to processing_thoughts to simulate it is already processing
        processing_thoughts.add(9999)
        try:
            # Running the task for 9999 should return immediately without executing database queries or logging warnings
            enrich_thought_task(9999)
        finally:
            # Clean up
            processing_thoughts.discard(9999)

    def test_todo_creation_and_toggling(self):
        thought = Thought(
            user_id=self.chris.id,
            content="Plan my trip",
            is_todo=True,
            todo_done=False
        )
        self.db.add(thought)
        self.db.commit()
        
        self.db.refresh(thought)
        self.assertTrue(thought.is_todo)
        self.assertFalse(thought.todo_done)
        
        # Toggle done
        thought.todo_done = True
        self.db.commit()
        
        self.db.refresh(thought)
        self.assertTrue(thought.todo_done)

    def test_reminder_local_to_utc_conversion(self):
        # Test offset conversion: Local (naive) + offset (minutes) = UTC
        reminder_at_str = "2026-06-16T09:00:00"
        timezone_offset = 240  # 4 hours
        
        dt_local = datetime.datetime.fromisoformat(reminder_at_str)
        dt_utc = dt_local + datetime.timedelta(minutes=timezone_offset)
        
        self.assertEqual(dt_utc.year, 2026)
        self.assertEqual(dt_utc.month, 6)
        self.assertEqual(dt_utc.day, 16)
        self.assertEqual(dt_utc.hour, 13)
        self.assertEqual(dt_utc.minute, 0)

    def test_reminders_dispatch_job_polling(self):
        # Create a reminder in the past
        past_time = datetime.datetime.utcnow() - datetime.timedelta(minutes=5)
        reminder = Thought(
            user_id=self.chris.id,
            content="Turn off the oven",
            is_reminder=True,
            reminder_at=past_time,
            reminder_sent=False
        )
        self.db.add(reminder)
        self.db.commit()
        
        # Poll database for due reminders
        due = self.db.query(Thought).filter(
            Thought.is_reminder == True,
            Thought.reminder_sent == False,
            Thought.reminder_at <= datetime.datetime.utcnow()
        ).all()
        
        self.assertEqual(len(due), 1)
        self.assertEqual(due[0].content, "Turn off the oven")
        
        # Simulate send
        due[0].reminder_sent = True
        self.db.commit()
        
        # Verify no more due reminders
        due_after = self.db.query(Thought).filter(
            Thought.is_reminder == True,
            Thought.reminder_sent == False,
            Thought.reminder_at <= datetime.datetime.utcnow()
        ).all()
        self.assertEqual(len(due_after), 0)

    def test_send_test_notification_endpoint(self):
        from fastapi.testclient import TestClient
        from main import app, get_current_user
        from unittest.mock import patch

        client = TestClient(app)
        
        # Override dependency with a transient User object to avoid DB session lazy-load thread errors
        test_user = User(username="chris", subdomain="chris")
        app.dependency_overrides[get_current_user] = lambda: test_user

        with patch("notifier.send_push_notification") as mock_send:
            # 1. Success case
            mock_send.return_value = True
            with patch("config.NTFY_TOPIC", "some_topic"):
                response = client.post("/api/user/test-notification")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["status"], "success")
                mock_send.assert_called_once_with("Test notification from your Deep Thought workspace (chris).\nView: https://chris.teamjames.cc")

            # Reset mock
            mock_send.reset_mock()

            # 2. No topic configured case
            with patch("config.NTFY_TOPIC", ""):
                response = client.post("/api/user/test-notification")
                self.assertEqual(response.status_code, 400)
                self.assertIn("missing", response.json()["detail"])

            # 3. Notification dispatch failed case
            mock_send.return_value = False
            with patch("config.NTFY_TOPIC", "some_topic"):
                response = client.post("/api/user/test-notification")
                self.assertEqual(response.status_code, 500)
                self.assertIn("Failed to dispatch", response.json()["detail"])
        
        # Clean up dependency overrides
        app.dependency_overrides.clear()

    def test_notifier_url_construction(self):
        from unittest.mock import patch
        from notifier import send_push_notification

        with patch("notifier.requests.post") as mock_post, \
             patch("config.NTFY_TOPIC", "my_topic"), \
             patch("config.TELEGRAM_BOT_TOKEN", ""), \
             patch("config.PUSHOVER_USER_KEY", ""), \
             patch("config.PUSHBULLET_API_KEY", ""):
            
            mock_post.return_value.status_code = 200

            # 1. Custom URL without trailing slash
            with patch("config.NTFY_URL", "http://my-private-ntfy.local"):
                send_push_notification("hello")
                mock_post.assert_called_with(
                    "http://my-private-ntfy.local/my_topic",
                    data="hello".encode("utf-8"),
                    headers={"Title": "Deep Thought Reminder"},
                    timeout=10
                )

            # 2. Custom URL with trailing slash
            mock_post.reset_mock()
            with patch("config.NTFY_URL", "http://my-private-ntfy.local/"):
                send_push_notification("hello")
                mock_post.assert_called_with(
                    "http://my-private-ntfy.local/my_topic",
                    data="hello".encode("utf-8"),
                    headers={"Title": "Deep Thought Reminder"},
                    timeout=10
                )

if __name__ == "__main__":
    unittest.main()

