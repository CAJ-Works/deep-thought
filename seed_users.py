import sys
from database import SessionLocal, User, hash_pin, init_db

def seed_users():
    db = SessionLocal()
    try:
        init_db()
        
        # User 1: Chris
        chris = db.query(User).filter(User.username == "chris").first()
        if not chris:
            print("Seeding user: 'chris'")
            hashed, salt = hash_pin("1234")  # Default PIN: 1234
            chris = User(
                username="chris",
                pin_hash=hashed,
                pin_salt=salt
            )
            db.add(chris)
        else:
            print("User 'chris' already exists.")
            
        # User 2: Brandon
        brandon = db.query(User).filter(User.username == "brandon").first()
        if not brandon:
            print("Seeding user: 'brandon'")
            hashed, salt = hash_pin("5678")  # Default PIN: 5678
            brandon = User(
                username="brandon",
                pin_hash=hashed,
                pin_salt=salt
            )
            db.add(brandon)
        else:
            print("User 'brandon' already exists.")
            
        db.commit()
        print("Users successfully seeded in the database.")
    except Exception as e:
        db.rollback()
        print(f"Error during seeding: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_users()
