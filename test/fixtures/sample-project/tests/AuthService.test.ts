import { AuthService } from '../src/auth/AuthService';

test('login rejects unknown user', () => {
  expect(new AuthService({ findByEmail: () => undefined } as never).login('a', 'b')).toBeNull();
});
