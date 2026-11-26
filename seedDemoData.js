/**
 * Idempotent demo data for LearnNest.
 *
 * Run with `npm run seed` from the server directory. Re-running never changes
 * existing passwords, enrollment decisions or creation dates; demo-owned
 * fields are refreshed so the moderation queue stays usable.
 *
 * Only the four application collections are touched:
 * users, courses, enrollments, payments.
 */
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { connectDB, closeDB, getDB } from './config/db.js';

dotenv.config();

const DEMO_PASSWORD = 'Tutor@12345';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@mentorlagbe.com').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';
const ADMIN_NAME = process.env.ADMIN_NAME || 'LearnNest Admin';
const USING_DEFAULT_ADMIN_PASSWORD = !process.env.ADMIN_PASSWORD;

// Pro instructors can publish more than the two-course free-plan limit.
const instructors = [
  {
    name: 'Sarah Ahmed',
    email: 'sarah@learnnest.app',
    phone: '+8801711000001',
    bio: 'Mathematics and IELTS instructor with 8 years of teaching experience.',
    plan: 'pro',
  },
  {
    name: 'Rahim Hasan',
    email: 'rahim@learnnest.app',
    phone: '+8801711000002',
    bio: 'Programming and science mentor who loves practical, project-based lessons.',
    plan: 'pro',
  },
];

const students = [
  {
    name: 'Student One',
    email: 'student1@learnnest.app',
    phone: '+8801811000001',
    bio: 'Preparing for HSC examinations.',
    plan: 'free',
  },
  {
    name: 'Student Two',
    email: 'student2@learnnest.app',
    phone: '+8801811000002',
    bio: 'Learning programming and spoken English.',
    plan: 'free',
  },
];

const image = (id) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=80`;

/**
 * Approved courses: 12 records across eight subject categories so the catalog
 * filters, search and category tiles all have something useful to show.
 * Fields match the shapes written by controllers/courseController.js.
 */
const courses = [
  ['Algebra Foundations', 'Mathematics', 'HSC', 'Online', '6 weeks', 3500, 'photo-1509062522246-3755977927d7', 'Equations, functions and exam-focused problem solving.', 'sarah@learnnest.app'],
  ['Calculus Essentials', 'Mathematics', 'University', 'Online', '8 weeks', 5000, 'photo-1635070041078-e363dbe005cb', 'Limits, derivatives and integrals explained step by step.', 'sarah@learnnest.app'],
  ['Full-Stack Web Development', 'Programming', 'Adult', 'Online', '12 weeks', 6000, 'photo-1498050108023-c5249f4df085', 'Build and deploy real applications with React, Node.js and MongoDB.', 'rahim@learnnest.app'],
  ['Python for Absolute Beginners', 'Programming', 'SSC', 'Online', '6 weeks', 3000, 'photo-1526379095098-d400fd0bf935', 'A friendly first step into programming with plenty of exercises.', 'rahim@learnnest.app'],
  ['Data Science Bootcamp', 'Programming', 'Adult', 'Online', '10 weeks', 6500, 'photo-1551288049-bebda4e38f71', 'Python data analysis, visualization and practical projects.', 'rahim@learnnest.app'],
  ['IELTS Intensive Preparation', 'IELTS', 'Adult', 'Online', '8 weeks', 4500, 'photo-1503676260728-1c00da094a0b', 'Band 7+ preparation with weekly mock tests and feedback.', 'sarah@learnnest.app'],
  ['Piano for Beginners', 'Music', 'Adult', 'Offline', '8 weeks', 4000, 'photo-1511379938547-c1f69419868d', 'Learn reading notes, rhythm and your first pieces on the piano.', 'sarah@learnnest.app'],
  ['Physics for HSC', 'Physics', 'HSC', 'Online', '10 weeks', 4000, 'photo-1636466497217-26a8cbeaf0aa', 'Mechanics, electricity and optics with numerical drills.', 'rahim@learnnest.app'],
  ['Modern Physics Crash Course', 'Physics', 'University', 'Online', '6 weeks', 5500, 'photo-1532094349884-543bc11b234d', 'Quantum mechanics and relativity explained visually.', 'rahim@learnnest.app'],
  ['Spoken English for Beginners', 'Language', 'SSC', 'Offline', '6 weeks', 2500, 'photo-1513258496099-48168024aec0', 'Conversation-focused classes to build speaking confidence.', 'sarah@learnnest.app'],
  ['Organic Chemistry Essentials', 'Chemistry', 'HSC', 'Offline', '8 weeks', 3200, 'photo-1554475901-4538ddfbccc2', 'Reaction mechanisms made easy with guided practice sheets.', 'rahim@learnnest.app'],
  ['Biology for Medical Entrance', 'Biology', 'HSC', 'Online', '10 weeks', 3800, 'photo-1530026405186-ed1f139313f8', 'Chapter-wise preparation with diagrams and past-question practice.', 'rahim@learnnest.app'],
];

// Two extra records keep the admin moderation queue demonstrable.
const moderationCourses = [
  ['Business Statistics for Beginners', 'Mathematics', 'Adult', 'Online', '4 weeks', 3600, 'photo-1551288049-bebda4e38f71', 'Practical statistics for everyday business decisions.', 'sarah@learnnest.app', 'pending'],
  ['Advanced Machine Learning', 'Programming', 'University', 'Online', '12 weeks', 7000, 'photo-1527474305487-b87b222841cc', 'An intensive introduction to machine learning models.', 'rahim@learnnest.app', 'rejected'],
];

async function upsertUser(users, user, role, password) {
  const update = {
    $set: {
      name: user.name,
      role,
      phone: user.phone || '',
      bio: user.bio || '',
      plan: user.plan || 'free',
      updatedAt: new Date(),
    },
    $setOnInsert: {
      email: user.email,
      password: await bcrypt.hash(password, 12),
      image: '',
      profileImage: '',
      createdAt: new Date(),
    },
  };

  await users.updateOne({ email: user.email }, update, { upsert: true });
}

async function seed() {
  await connectDB();

  const db = getDB();
  const users = db.collection('users');
  const coursesCollection = db.collection('courses');
  const enrollments = db.collection('enrollments');
  const payments = db.collection('payments');

  await upsertUser(
    users,
    { name: ADMIN_NAME, email: ADMIN_EMAIL },
    'admin',
    ADMIN_PASSWORD,
  );

  for (const instructor of instructors) {
    await upsertUser(users, instructor, 'instructor', DEMO_PASSWORD);
  }

  for (const student of students) {
    await upsertUser(users, student, 'student', DEMO_PASSWORD);
  }

  const now = Date.now();
  const savedCourses = [];

  const allCourses = [
    ...courses.map((course) => [...course, 'approved']),
    ...moderationCourses,
  ];

  for (const [
    title,
    category,
    level,
    mode,
    duration,
    price,
    photoId,
    description,
    instructorEmail,
    approvalStatus,
  ] of allCourses) {
    const instructor = instructors.find((item) => item.email === instructorEmail);
    const { createdAt, ...fields } = {
      title,
      category,
      level,
      mode,
      duration,
      price,
      thumbnail: image(photoId),
      description,
      instructorName: instructor.name,
      instructorEmail,
      approvalStatus,
      status: approvalStatus,
      approved: approvalStatus === 'approved',
      isApproved: approvalStatus === 'approved',
      isActive: approvalStatus === 'approved',
      createdAt: new Date(now - savedCourses.length * 86_400_000),
      updatedAt: new Date(),
    };

    await coursesCollection.updateOne(
      { title, instructorEmail },
      { $set: fields, $setOnInsert: { createdAt } },
      { upsert: true },
    );

    const saved = await coursesCollection.findOne({ title, instructorEmail });
    savedCourses.push(saved);
  }

  // Indexes by approved position; demo enrollments always point at approved,
  // active courses so the student and instructor views are populated.
  const approved = savedCourses.filter((course) => course.approvalStatus === 'approved');

  const sampleEnrollments = [
    [0, 0, 'accepted', 'Weekdays 6-8 PM', 'I need help with exam preparation.'],
    [5, 0, 'pending', 'Weekend mornings', 'Targeting band 7 in IELTS.'],
    [2, 1, 'accepted', 'Evenings after 7 PM', 'Interested in full-stack development.'],
    [9, 1, 'pending', 'Saturday 10 AM', 'I want to practise spoken English.'],
    [10, 1, 'rejected', 'Friday 5 PM', 'Chemistry classes with lab examples.'],
  ];

  for (const [courseIndex, studentIndex, status, preferredSchedule, note] of sampleEnrollments) {
    const course = approved[courseIndex];
    const student = students[studentIndex];
    const courseId = course._id.toString();

    await enrollments.updateOne(
      { courseId, studentEmail: student.email },
      {
        $setOnInsert: {
          courseId,
          courseTitle: course.title,
          instructorEmail: course.instructorEmail,
          instructorName: course.instructorName,
          studentName: student.name,
          studentEmail: student.email,
          studentPhone: student.phone,
          preferredSchedule,
          note,
          status,
          appliedAt: new Date(now - courseIndex * 3_600_000),
          ...(status === 'pending' ? {} : { reviewedAt: new Date(now - courseIndex * 1_800_000) }),
        },
      },
      { upsert: true },
    );
  }

  // Demo transactions so the admin revenue and transactions views are populated.
  const demoPayments = [
    ['sarah@learnnest.app', 'Sarah Ahmed', 'instructor', 'Pro Instructor Plan', 15, 'cs_demo_instructor_sarah'],
    ['rahim@learnnest.app', 'Rahim Hasan', 'instructor', 'Pro Instructor Plan', 15, 'cs_demo_instructor_rahim'],
    ['student1@learnnest.app', 'Student One', 'student', 'Pro Student Plan', 10, 'cs_demo_student_one'],
  ];

  for (const [index, [userEmail, userName, userRole, planName, amount, stripeSessionId]] of demoPayments.entries()) {
    await payments.updateOne(
      { stripeSessionId },
      {
        $setOnInsert: {
          userEmail,
          userName,
          userRole,
          planName,
          amount,
          currency: 'USD',
          transactionId: `pi_demo_${stripeSessionId}`,
          stripeSessionId,
          stripeSubscriptionId: `sub_demo_${stripeSessionId}`,
          paymentStatus: 'paid',
          paidAt: new Date(now - index * 86_400_000),
          createdAt: new Date(now - index * 86_400_000),
        },
      },
      { upsert: true },
    );
  }

  console.log(
    'Seed complete: admin, 2 instructors, 2 students, 12 approved courses, ' +
      '1 pending + 1 rejected course, 5 enrollments and 3 demo payments.',
  );
  console.log(
    USING_DEFAULT_ADMIN_PASSWORD
      ? `Admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`
      : `Admin login: ${ADMIN_EMAIL} / password set in the environment`,
  );
  console.log(`Instructor login: ${instructors[0].email} / ${DEMO_PASSWORD}`);
  console.log(`Student login: ${students[0].email} / ${DEMO_PASSWORD}`);
}

seed()
  .catch((error) => {
    console.error('Seed failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDB().catch(() => {});
    process.exit();
  });
