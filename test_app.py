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

if __name__ == "__main__":
    unittest.main()
